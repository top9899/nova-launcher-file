const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const net = require('node:net');
const { Client } = require('minecraft-launcher-core');
const execFileAsync = promisify(execFile);
const MODRINTH_API = 'https://api.modrinth.com/v2';
const MODRINTH_HEADERS = { 'User-Agent': 'NOVA-Launcher/1.0.0 (https://modrinth.com)' };

async function detectJava() {
  try {
    const { stdout, stderr } = await execFileAsync('java', ['-version'], { timeout: 5000, windowsHide: true });
    const output = `${stderr || ''}\n${stdout || ''}`;
    const match = output.match(/version "([^"]+)"/i);
    const version = match?.[1] || 'установлена';
    const major = version.startsWith('1.') ? Number(version.split('.')[1]) : Number(version.split('.')[0]);
    let javaPath = 'java';
    let javawPath = process.platform === 'win32' ? 'javaw' : 'java';
    if (process.platform === 'win32') {
      try {
        const resolved = await execFileAsync('where.exe', ['java'], { timeout: 5000, windowsHide: true });
        const candidate = resolved.stdout.split(/\r?\n/).map(value => value.trim()).find(value => /java\.exe$/i.test(value) && fs.existsSync(value));
        if (candidate) {
          javaPath = candidate;
          const sibling = candidate.replace(/java\.exe$/i, 'javaw.exe');
          if (fs.existsSync(sibling)) javawPath = sibling;
        }
        if (javawPath === 'javaw') {
          const resolvedWindowed = await execFileAsync('where.exe', ['javaw'], { timeout: 5000, windowsHide: true });
          const windowed = resolvedWindowed.stdout.split(/\r?\n/).map(value => value.trim()).find(value => /javaw\.exe$/i.test(value) && fs.existsSync(value));
          if (windowed) javawPath = windowed;
        }
      } catch {}
    }
    return { available: true, version, major, javaPath, javawPath };
  } catch {
    return { available: false };
  }
}

let win;
let gameProcess = null;
let launchInProgress = false;
let fabricInstallInProgress = false;
const DISCORD_APPLICATION_ID = '1566111842445824080';
const discordConfig = { enabled: true, applicationId: DISCORD_APPLICATION_ID };
let discordSocket = null;
let discordBuffer = Buffer.alloc(0);
let discordRetryTimer = null;
let discordNonce = 0;
let discordConnected = false;
let discordStatusText = 'Запускаем связь с Discord…';
let discordGame = null;
const gameRoot = () => path.join(app.getPath('appData'), 'NOVA Launcher', 'minecraft');
const profileRoot = (mcVersion, loader) => path.join(gameRoot(), 'profiles', mcVersion, loader);

function discordSendStatus(message) {
  discordStatusText = String(message);
  if (win && !win.isDestroyed()) win.webContents.send('launcher:event', { kind: 'discord-status', data: message });
}

function discordFrame(opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

function discordDisconnect(message = 'Discord не подключён') {
  discordConnected = false;
  const socket = discordSocket;
  discordSocket = null;
  discordBuffer = Buffer.alloc(0);
  if (socket && !socket.destroyed) socket.destroy();
  if (discordRetryTimer) clearTimeout(discordRetryTimer);
  discordRetryTimer = null;
  if (discordConfig.enabled) {
    discordSendStatus(message);
    discordRetryTimer = setTimeout(discordConnect, 15000);
    discordRetryTimer.unref?.();
  }
}

function discordActivity() {
  const activity = discordGame
    ? { details: `Minecraft ${discordGame.version}`, state: `${discordGame.loader} · ${discordGame.name}`, type: 0, ...(discordGame.startedAt ? { timestamps: { start: discordGame.startedAt } } : {}) }
    : { details: 'Настраивает приключение', state: 'В лаунчере NOVA', type: 0 };
  if (!discordConnected || !discordSocket || discordSocket.destroyed) return;
  discordSocket.write(discordFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: String(++discordNonce) }));
}

function discordConnect() {
  if (!discordConfig.enabled || !/^\d{17,20}$/.test(discordConfig.applicationId) || discordSocket) return;
  let pipe = 0;
  const tryPipe = () => {
    if (!discordConfig.enabled || discordSocket) return;
    if (pipe > 9) { discordDisconnect('Открой Discord для отображения статуса'); return; }
    const socket = net.createConnection(`\\\\?\\pipe\\discord-ipc-${pipe++}`);
    socket.once('connect', () => {
      discordSocket = socket;
      discordBuffer = Buffer.alloc(0);
      // Discord expects the client handshake first and then replies with READY.
      socket.write(discordFrame(0, { v: 1, client_id: DISCORD_APPLICATION_ID }));
    });
    socket.on('data', chunk => {
      discordBuffer = Buffer.concat([discordBuffer, chunk]);
      while (discordBuffer.length >= 8) {
        const opcode = discordBuffer.readInt32LE(0);
        const length = discordBuffer.readInt32LE(4);
        if (discordBuffer.length < 8 + length) break;
        const raw = discordBuffer.subarray(8, 8 + length).toString('utf8');
        discordBuffer = discordBuffer.subarray(8 + length);
        let packet; try { packet = JSON.parse(raw); } catch { continue; }
        if (packet.evt === 'READY') {
          discordConnected = true;
          discordSendStatus('Подключено · статус показывается в Discord');
          discordActivity();
        } else if (packet.evt === 'ERROR') {
          const code = packet.data?.code;
          const message = packet.data?.message || 'Discord отклонил Rich Presence';
          discordSendStatus(`Discord RPC ${code ? `${code}: ` : ''}${message}`);
        }
      }
    });
    socket.on('error', () => { if (discordSocket === socket) discordSocket = null; tryPipe(); });
    socket.on('close', () => { if (discordSocket === socket) discordDisconnect(); });
  };
  tryPipe();
}

async function getJson(url, label = 'Сервис сейчас недоступен') {
  const response = await fetch(url, { headers: MODRINTH_HEADERS });
  if (!response.ok) throw new Error(`${label} (${response.status}).`);
  return response.json();
}

function safeSegment(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._+-]{1,100}$/.test(value)) throw new Error('Недопустимое имя версии.');
  return value;
}

async function downloadVerified(url, destination, hashes = {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Не удалось скачать файл (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  for (const algorithm of ['sha1', 'sha512']) {
    if (hashes[algorithm]) {
      const actual = createHash(algorithm).update(bytes).digest('hex');
      if (actual.toLowerCase() !== hashes[algorithm].toLowerCase()) throw new Error('Контрольная сумма скачанного файла не совпала.');
      break;
    }
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, destination);
}

async function getForgeVersions(mcVersion) {
  safeSegment(mcVersion);
  const base = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
  const [metadataResponse, promotions] = await Promise.all([
    fetch(`${base}/maven-metadata.xml`),
    getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json', 'Не удалось получить версии Forge')
  ]);
  if (!metadataResponse.ok) throw new Error('Не удалось получить список версий Forge.');
  const xml = await metadataResponse.text();
  const prefix = `${mcVersion}-`;
  const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map(match => match[1])
    .filter(value => value.startsWith(prefix))
    .map(value => value.slice(prefix.length));
  const promo = promotions.promos || {};
  const preferred = [promo[`${mcVersion}-recommended`], promo[`${mcVersion}-latest`]].filter(Boolean);
  const unique = [...new Set([...preferred, ...all])].filter(value => all.includes(value));
  unique.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  return unique;
}

async function ensureFabricProfile(mcVersion, loaderVersion, baseVersion) {
  safeSegment(mcVersion);
  safeSegment(loaderVersion);
  const profile = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`, 'Не удалось получить Fabric');
  const profileId = safeSegment(profile.id);
  const folder = path.join(gameRoot(), 'versions', profileId);
  const cached = path.join(folder, `${profileId}.json`);
  if (!fs.existsSync(cached)) {
    const baseJson = await getJson(baseVersion.url, 'Не удалось получить Minecraft');
    const vanillaGameArgs = baseJson.arguments?.game || [];
    const loaderGameArgs = profile.arguments?.game || [];
    const vanillaJvmArgs = baseJson.arguments?.jvm || [];
    const loaderJvmArgs = profile.arguments?.jvm || [];
    const merged = {
      ...baseJson,
      ...profile,
      id: profileId,
      inheritsFrom: mcVersion,
      downloads: baseJson.downloads,
      assets: baseJson.assets,
      assetIndex: baseJson.assetIndex,
      libraries: [...(baseJson.libraries || []), ...(profile.libraries || [])],
      arguments: { game: [...vanillaGameArgs, ...loaderGameArgs], jvm: [...vanillaJvmArgs, ...loaderJvmArgs] }
    };
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(cached, JSON.stringify(merged, null, 2));
    fs.writeFileSync(path.join(folder, `${mcVersion}.json`), JSON.stringify(merged, null, 2));
  }
  const client = baseVersion.downloads?.client;
  if (!client?.url) throw new Error('В каталоге Minecraft не найден клиентский файл этой версии.');
  const baseJar = path.join(gameRoot(), 'versions', mcVersion, `${mcVersion}.jar`);
  let clientIsValid = fs.existsSync(baseJar);
  if (clientIsValid && client.sha1) clientIsValid = createHash('sha1').update(fs.readFileSync(baseJar)).digest('hex') === client.sha1;
  if (!clientIsValid) await downloadVerified(client.url, baseJar, { sha1: client.sha1 });
  const profileFolder = profileRoot(mcVersion, 'fabric');
  fs.mkdirSync(profileFolder, { recursive: true });
  fs.writeFileSync(path.join(profileFolder, '.nova-profile.json'), JSON.stringify({ loader: 'fabric', gameVersion: mcVersion, loaderVersion, profileId, updatedAt: new Date().toISOString() }, null, 2));
  return { profileId, baseJar };
}

async function getModrinthVersions(projectId, mcVersion, loader) {
  if (!/^[A-Za-z0-9_-]{2,100}$/.test(projectId)) throw new Error('Некорректный идентификатор мода.');
  if (!['fabric', 'forge'].includes(loader)) throw new Error('Для модов сначала выбери Fabric или Forge.');
  const query = new URLSearchParams({ game_versions: JSON.stringify([mcVersion]), loaders: JSON.stringify([loader]), include_changelog: 'false' });
  return getJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version?${query}`, 'Не удалось получить версии мода');
}

async function installModrinthVersion({ version, mcVersion, loader, onProgress }) {
  const root = profileRoot(safeSegment(mcVersion), loader);
  const modsFolder = path.join(root, 'mods');
  fs.mkdirSync(modsFolder, { recursive: true });
  const installedProjects = new Set();
  let installedFiles = 0;
  let totalFiles = 1;
  const loadVersion = async dependency => {
    if (dependency.version_id) return getJson(`${MODRINTH_API}/version/${encodeURIComponent(dependency.version_id)}`, 'Не удалось получить зависимость');
    const candidates = await getModrinthVersions(dependency.project_id, mcVersion, loader);
    const compatible = candidates.find(item => item.version_type === 'release') || candidates[0];
    if (!compatible) throw new Error(`Не найдена версия обязательной зависимости ${dependency.project_id}.`);
    return compatible;
  };
  const installOne = async (modVersion, depth = 0) => {
    if (depth > 12) throw new Error('Слишком длинная цепочка зависимостей мода.');
    if (!modVersion?.project_id || installedProjects.has(modVersion.project_id)) return;
    if (!modVersion.game_versions?.includes(mcVersion) || !modVersion.loaders?.includes(loader)) {
      throw new Error(`Версия мода ${modVersion.name || modVersion.project_id} несовместима с Minecraft ${mcVersion} / ${loader}.`);
    }
    installedProjects.add(modVersion.project_id);
    const required = (modVersion.dependencies || []).filter(item => item.dependency_type === 'required');
    totalFiles += required.length;
    for (const dependency of required) await installOne(await loadVersion(dependency), depth + 1);
    const file = (modVersion.files || []).find(item => item.primary && item.filename?.toLowerCase().endsWith('.jar'))
      || (modVersion.files || []).find(item => item.filename?.toLowerCase().endsWith('.jar'));
    if (!file) throw new Error(`Для ${modVersion.name || modVersion.project_id} нет клиентского .jar-файла.`);
    const fileUrl = new URL(file.url);
    if (fileUrl.protocol !== 'https:' || !fileUrl.hostname.endsWith('.modrinth.com')) throw new Error('Источник файла не прошёл проверку безопасности Modrinth.');
    const filename = path.basename(file.filename);
    if (filename !== file.filename || filename.includes('..')) throw new Error('Сервис вернул недопустимое имя файла.');
    const destination = path.join(modsFolder, filename);
    const existingHash = file.hashes?.sha1;
    let alreadyInstalled = false;
    if (fs.existsSync(destination) && existingHash) {
      const localHash = createHash('sha1').update(fs.readFileSync(destination)).digest('hex');
      alreadyInstalled = localHash === existingHash;
    }
    if (!alreadyInstalled) await downloadVerified(file.url, destination, file.hashes || {});
    installedFiles++;
    onProgress?.({ current: installedFiles, total: totalFiles, name: filename });
  };
  await installOne(version);
  return { installed: installedFiles, folder: modsFolder };
}

async function latestFabricApi(mcVersion) {
  const versions = await getModrinthVersions('P7dR8mSH', mcVersion, 'fabric');
  const item = versions.find(version => version.version_type === 'release') || versions[0];
  if (!item) throw new Error(`Не нашлась Fabric API для Minecraft ${mcVersion}.`);
  return item;
}

async function installFabricApi(mcVersion, onProgress) {
  const modsFolder = path.join(profileRoot(mcVersion, 'fabric'), 'mods');
  if (fs.existsSync(modsFolder) && fs.readdirSync(modsFolder).some(name => /^fabric-api-.*\.jar$/i.test(name))) return { installed: 0, folder: modsFolder };
  const version = await latestFabricApi(mcVersion);
  return installModrinthVersion({ version, mcVersion, loader: 'fabric', onProgress });
}

const projectsRoot = () => path.join(app.getPath('documents'), 'NOVA Mods');
const aiKeyFile = () => path.join(app.getPath('userData'), 'ai-keys.json');
const projectPath = projectId => {
  if (typeof projectId !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,48}$/.test(projectId)) throw new Error('Некорректное имя проекта.');
  const folder = path.resolve(projectsRoot(), projectId);
  if (!folder.startsWith(`${path.resolve(projectsRoot())}${path.sep}`)) throw new Error('Недопустимая папка проекта.');
  return folder;
};
const ignoredProjectFolders = new Set(['.git', '.gradle', '.idea', '.vscode', 'out']);
const textProjectExtensions = new Set(['.java', '.json', '.json5', '.properties', '.gradle', '.md', '.mdx', '.txt', '.toml', '.accesswidener', '.mixins', '.mcmeta', '.mcfunction', '.yml', '.yaml', '.xml', '.bat', '.sh', '.kt', '.kts', '.groovy', '.cfg', '.lang', '.js', '.jsx', '.ts', '.tsx', '.html', '.css', '.scss', '.svg', '.mf', '.csv', '.vsh', '.fsh', '.glsl', '.obj', '.mtl']);
function isEditableProjectFile(name) {
  return textProjectExtensions.has(path.extname(name).toLowerCase()) || ['.gitignore', '.gitattributes', 'LICENSE', 'NOTICE'].includes(name);
}
function resolveProjectEntry(projectId, relative, { mustExist = false } = {}) {
  const root = projectPath(projectId);
  if (typeof relative !== 'string' || !relative || relative.length > 500 || /^[a-z]:|^[/\\]/i.test(relative)) throw new Error('Некорректный путь проекта.');
  const parts = relative.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw new Error('Некорректный путь проекта.');
  const destination = path.resolve(root, ...parts);
  if (!destination.startsWith(`${root}${path.sep}`)) throw new Error('Путь выходит за границы проекта.');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    if (!fs.existsSync(current)) {
      if (mustExist) throw new Error('Файл проекта не найден.');
      continue;
    }
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Символические ссылки внутри проекта не поддерживаются.');
  }
  return destination;
}
const devFiles = projectId => {
  const folder = projectPath(projectId);
  if (!fs.existsSync(folder)) throw new Error('Проект не найден.');
  const entries = [];
  const walk = (base, relative = '', depth = 0) => {
    if (depth > 16) return;
    for (const item of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))) {
      const rel = relative ? `${relative}/${item.name}` : item.name;
      const full = path.join(base, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) {
        if (ignoredProjectFolders.has(item.name)) continue;
        entries.push({ path: rel, type: 'directory' });
        walk(full, rel, depth + 1);
      } else if (item.isFile()) entries.push({ path: rel, type: 'file', editable: isEditableProjectFile(item.name) });
    }
  };
  walk(folder);
  return entries;
};
function saveAiKeys(data) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранилище Windows сейчас недоступно.');
  let encrypted = {};
  try { encrypted = fs.existsSync(aiKeyFile()) ? JSON.parse(fs.readFileSync(aiKeyFile(), 'utf8')) : {}; } catch {}
  for (const provider of ['openai', 'gemini', 'anthropic']) {
    const key = String(data?.[provider] || '').trim();
    if (key) encrypted[provider] = safeStorage.encryptString(key).toString('base64');
  }
  fs.mkdirSync(path.dirname(aiKeyFile()), { recursive: true });
  fs.writeFileSync(aiKeyFile(), JSON.stringify(encrypted), { mode: 0o600 });
}
function readAiKey(provider) {
  if (!fs.existsSync(aiKeyFile())) return '';
  const data = JSON.parse(fs.readFileSync(aiKeyFile(), 'utf8'));
  const encoded = data[provider];
  return encoded && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(encoded, 'base64')) : '';
}

function createWindow() {
  win = new BrowserWindow({ width: 1360, height: 850, minWidth: 1050, minHeight: 700, backgroundColor: '#101116', title: 'NOVA Launcher', icon: path.join(__dirname, 'icon.ico'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[NOVA] Renderer failed to load (${code}): ${description} — ${url}`);
    dialog.showErrorBox('NOVA Launcher — ошибка окна', `Не удалось открыть интерфейс лаунчера.\n${description}`);
  });
  win.loadFile(path.join(__dirname, 'index.html')).catch(error => {
    console.error('[NOVA] Could not load interface:', error);
    dialog.showErrorBox('NOVA Launcher — ошибка окна', `Не удалось открыть интерфейс лаунчера.\n${error.message}`);
  });
}
app.whenReady().then(() => { createWindow(); discordConnect(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (discordRetryTimer) clearTimeout(discordRetryTimer);
  discordConfig.enabled = false;
  if (discordConnected && discordSocket) discordSocket.write(discordFrame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: String(++discordNonce) }));
  discordSocket?.end();
});
ipcMain.handle('launcher:discord-status', () => discordStatusText);


ipcMain.handle('launcher:versions', async () => {
  const response = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
  if (!response.ok) throw new Error('Каталог версий сейчас недоступен.');
  const manifest = await response.json();
  return { latest: manifest.latest, versions: manifest.versions.map(({ id, type, releaseTime }) => ({ id, type, releaseTime })) };
});

ipcMain.handle('launcher:fabric-versions', async (_event, mcVersion) => {
  safeSegment(mcVersion);
  const result = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`, 'Не удалось получить версии Fabric');
  return result.filter(item => item.loader?.version).map(item => ({ version: item.loader.version, stable: item.loader.stable === true }));
});
ipcMain.handle('launcher:installed-profiles', async () => {
  const root = path.join(gameRoot(), 'profiles');
  if (!fs.existsSync(root)) return [];
  const installed = [];
  for (const mcVersion of fs.readdirSync(root)) {
    const profileFolder = path.join(root, mcVersion, 'fabric');
    const marker = path.join(profileFolder, '.nova-profile.json');
    if (!fs.existsSync(marker)) continue;
    try { installed.push(JSON.parse(fs.readFileSync(marker, 'utf8'))); } catch {}
  }
  return installed;
});
ipcMain.handle('launcher:install-fabric', async (event, mcVersion) => {
  safeSegment(mcVersion);
  if (launchInProgress || gameProcess || fabricInstallInProgress) throw new Error('Дождись завершения текущего запуска или установки.');
  fabricInstallInProgress = true;
  try {
    const manifest = await getJson('https://launchermeta.mojang.com/mc/game/version_manifest.json', 'Не удалось получить каталог Minecraft');
    const baseVersion = manifest.versions.find(item => item.id === mcVersion);
    if (!baseVersion) throw new Error('Этой версии Minecraft нет в каталоге. Обнови список версий.');
    const loaders = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`, 'Для этой версии Minecraft нет Fabric');
    const loaderVersion = loaders.find(item => item.loader?.stable)?.loader?.version || loaders[0]?.loader?.version;
    if (!loaderVersion) throw new Error(`Fabric пока не поддерживает Minecraft ${mcVersion}.`);
    const profile = await ensureFabricProfile(mcVersion, loaderVersion, baseVersion);
    const sendProgress = data => { if (!event.sender.isDestroyed()) event.sender.send('launcher:event', { kind: 'fabric-install-progress', data: JSON.stringify(data) }); };
    await installFabricApi(mcVersion, sendProgress);
    return { mcVersion, loaderVersion, profileId: profile.profileId };
  } finally { fabricInstallInProgress = false; }
});

ipcMain.handle('launcher:forge-versions', async (_event, mcVersion) => getForgeVersions(mcVersion));
ipcMain.handle('dev:versions', async () => {
  const result = await getJson('https://launchermeta.mojang.com/mc/game/version_manifest.json', 'Каталог версий недоступен');
  return result.versions.filter(item => item.type === 'release').slice(0, 80).map(item => item.id);
});
ipcMain.handle('dev:projects', async () => {
  fs.mkdirSync(projectsRoot(), { recursive: true });
  return fs.readdirSync(projectsRoot(), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => {
    const folder = path.join(projectsRoot(), item.name);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'src/main/resources/fabric.mod.json'), 'utf8'));
      const properties = fs.readFileSync(path.join(folder, 'gradle.properties'), 'utf8');
      return { id: item.name, title: manifest.name, mcVersion: properties.match(/^minecraft_version=(.+)$/m)?.[1]?.trim(), folder };
    }
    catch { return null; }
  }).filter(Boolean);
});
ipcMain.handle('dev:create', async (_event, { name, projectId, packageName, mcVersion }) => {
  safeSegment(mcVersion);
  if (!/^[A-Za-z][A-Za-z0-9 ]{1,39}$/.test(name)) throw new Error('Название мода: 2–40 символов, латиница и цифры.');
  const id = String(projectId || '').toLowerCase();
  const folder = projectPath(id);
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(id)) throw new Error('ID мода: латиница, цифры и подчёркивание.');
  const pkg = String(packageName || '').trim();
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,6}$/.test(pkg)) throw new Error('Пакет должен быть в формате dev.вашеимя.мод.');
  if (fs.existsSync(folder)) throw new Error('Проект с таким ID уже существует.');
  const modClass = id.split(/[-_]/).map(word => word[0].toUpperCase() + word.slice(1)).join('') + 'Mod';
  const meta = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`, 'Нет доступных версий Fabric');
  const loaderVersion = meta.find(item => item.loader?.stable)?.loader?.version || meta[0]?.loader?.version;
  if (!loaderVersion) throw new Error('Нет сборки Fabric для этой версии Minecraft.');
  const fabricApiVersion = (await latestFabricApi(mcVersion)).version_number;
  const unobfuscatedMinecraft = Number(mcVersion.split('.')[0]) >= 26;
  const loomPlugin = unobfuscatedMinecraft ? 'net.fabricmc.fabric-loom' : 'net.fabricmc.fabric-loom-remap';
  const loomMarker = unobfuscatedMinecraft ? 'fabric-loom/net.fabricmc.fabric-loom.gradle.plugin' : 'fabric-loom-remap/net.fabricmc.fabric-loom-remap.gradle.plugin';
  let loomVersion = '1.19.3';
  try {
    const loomResponse = await fetch(`https://maven.fabricmc.net/net/fabricmc/${loomMarker}/maven-metadata.xml`);
    if (loomResponse.ok) {
      const loomXml = await loomResponse.text();
      const release = loomXml.match(/<release>([^<]+)<\/release>/)?.[1];
      const versions = [...loomXml.matchAll(/<version>([^<]+)<\/version>/g)].map(match => match[1]).filter(version => /^\d+\.\d+\.\d+$/.test(version));
      loomVersion = release && /^\d+\.\d+\.\d+$/.test(release) ? release : versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) || loomVersion;
    }
  } catch {}
  const oldVersion = mcVersion.match(/^1\.(\d+)(?:\.(\d+))?/);
  const oldMinor = oldVersion ? Number(oldVersion[1]) : 21;
  const oldPatch = oldVersion ? Number(oldVersion[2] || 0) : 0;
  const javaVersion = unobfuscatedMinecraft ? 25 : oldMinor > 20 || (oldMinor === 20 && oldPatch >= 5) ? 21 : oldMinor >= 18 ? 17 : oldMinor === 17 ? 16 : 8;
  const gradleVersion = '9.2.1';
  const javaSource = `package ${pkg};\n\nimport net.fabricmc.api.ModInitializer;\nimport org.slf4j.Logger;\nimport org.slf4j.LoggerFactory;\n\npublic class ${modClass} implements ModInitializer {\n    public static final String MOD_ID = "${id}";\n    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);\n\n    @Override\n    public void onInitialize() {\n        LOGGER.info("${name} готов к работе!");\n    }\n}\n`;
  fs.mkdirSync(path.join(folder, 'src/main/java', ...pkg.split('.')), { recursive: true });
  fs.mkdirSync(path.join(folder, 'src/main/resources'), { recursive: true });
  const files = {
    'settings.gradle': `pluginManagement { repositories { maven { url = 'https://maven.fabricmc.net/' }; gradlePluginPortal(); mavenCentral() } }\nrootProject.name = '${id}'\n`,
    'build.gradle': `plugins { id '${loomPlugin}' version '${loomVersion}' }\n\nversion = project.mod_version\ngroup = project.maven_group\n\nbase { archivesName = project.archives_base_name }\n\nrepositories { maven { url = 'https://maven.fabricmc.net/' }; mavenCentral() }\n\ndependencies {\n    minecraft "com.mojang:minecraft:${mcVersion}"\n    ${unobfuscatedMinecraft ? '' : 'mappings loom.officialMojangMappings()\n    '}modImplementation "net.fabricmc:fabric-loader:${loaderVersion}"\n    modImplementation "net.fabricmc.fabric-api:fabric-api:${fabricApiVersion}"\n}\n\nprocessResources { inputs.property 'version', project.version; filesMatching('fabric.mod.json') { expand 'version': project.version } }\njava { sourceCompatibility = JavaVersion.toVersion(${javaVersion}); targetCompatibility = JavaVersion.toVersion(${javaVersion}); withSourcesJar() }\n`,
    'gradle.properties': `org.gradle.jvmargs=-Xmx2G\norg.gradle.parallel=true\nminecraft_version=${mcVersion}\nloader_version=${loaderVersion}\nfabric_api_version=${fabricApiVersion}\nmod_version=1.0.0\nmaven_group=${pkg}\narchives_base_name=${id}\n`,
    'src/main/resources/fabric.mod.json': JSON.stringify({ schemaVersion: 1, id, version: '${version}', name, description: `A Fabric mod made with NOVA Launcher.`, authors: ['${name}'], environment: '*', entrypoints: { main: [`${pkg}.${modClass}`] }, depends: { fabricloader: '>=${loaderVersion}', minecraft: `=${mcVersion}`, java: `>=${javaVersion}`, 'fabric-api': '*' } }, null, 2),
    [`src/main/java/${pkg.split('.').join('/')}/${modClass}.java`]: javaSource,
    'README.md': `# ${name}\n\nFabric mod for Minecraft ${mcVersion}.\n\n- Edit the Java source in \`src/main/java\`.\n- Build a distributable mod with \`gradlew.bat build\`.\n- The JAR is created in \`build/libs\`.\n`
  };
  const wrapperFiles = await Promise.all([
    `https://raw.githubusercontent.com/gradle/gradle/v${gradleVersion}/gradle/wrapper/gradle-wrapper.jar`,
    `https://raw.githubusercontent.com/gradle/gradle/v${gradleVersion}/gradlew.bat`
  ].map(async url => { const response = await fetch(url); if (!response.ok) throw new Error('Не удалось скачать Gradle Wrapper. Проверь подключение и попробуй снова.'); return Buffer.from(await response.arrayBuffer()); }));
  for (const [relative, contents] of Object.entries(files)) { const destination = path.join(folder, relative); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, contents); }
  const wrapperDir = path.join(folder, 'gradle/wrapper'); fs.mkdirSync(wrapperDir, { recursive: true });
  fs.writeFileSync(path.join(wrapperDir, 'gradle-wrapper.jar'), wrapperFiles[0]);
  fs.writeFileSync(path.join(folder, 'gradlew.bat'), wrapperFiles[1]);
  fs.writeFileSync(path.join(wrapperDir, 'gradle-wrapper.properties'), `distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\nnetworkTimeout=10000\nvalidateDistributionUrl=true\nzipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\ndistributionUrl=https\\://services.gradle.org/distributions/gradle-${gradleVersion}-bin.zip\n`);
  return { id, title: name, mcVersion, folder, files: Object.keys(files) };
});
ipcMain.handle('dev:read', async (_event, { projectId, file }) => {
  if (!devFiles(projectId).some(entry => entry.path === file && entry.type === 'file' && entry.editable)) throw new Error('Этот файл нельзя открыть в текстовом редакторе.');
  const contents = fs.readFileSync(resolveProjectEntry(projectId, file, { mustExist: true }), 'utf8');
  if (contents.includes('\0')) throw new Error('Этот файл бинарный, он не открывается в текстовом редакторе.');
  return contents;
});
ipcMain.handle('dev:files', async (_event, { projectId }) => devFiles(projectId));
ipcMain.handle('dev:write', async (_event, { projectId, file, contents }) => {
  if (!devFiles(projectId).some(entry => entry.path === file && entry.type === 'file' && entry.editable)) throw new Error('Этот файл нельзя редактировать.');
  if (typeof contents !== 'string' || contents.length > 1_000_000) throw new Error('Файл слишком большой.');
  fs.writeFileSync(resolveProjectEntry(projectId, file, { mustExist: true }), contents, 'utf8');
  return true;
});
ipcMain.handle('dev:reveal-entry', async (_event, { projectId, entryPath }) => {
  const target = resolveProjectEntry(projectId, entryPath, { mustExist: true });
  if (!fs.statSync(target).isFile()) throw new Error('Выбери файл проекта.');
  shell.showItemInFolder(target);
  return true;
});
ipcMain.handle('dev:create-entry', async (_event, { projectId, entryPath, type }) => {
  if (!['file', 'directory'].includes(type)) throw new Error('Выбери файл или папку.');
  const destination = resolveProjectEntry(projectId, entryPath);
  const baseName = path.basename(destination);
  if (type === 'file' && !isEditableProjectFile(baseName)) throw new Error('Поддерживаются текстовые файлы Java, JSON, Gradle и ресурсов.');
  if (fs.existsSync(destination)) throw new Error('Такой файл или папка уже существуют.');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (type === 'directory') fs.mkdirSync(destination);
  else fs.writeFileSync(destination, '', { flag: 'wx' });
  return { path: entryPath, type };
});
ipcMain.handle('dev:open', async (_event, { projectId }) => {
  const folder = projectPath(projectId);
  const error = await shell.openPath(folder);
  if (error) throw new Error(`Не получилось открыть проект: ${error}`);
  return folder;
});
ipcMain.handle('dev:delete', async (_event, { projectId }) => {
  const folder = projectPath(projectId);
  if (devProcess && devProcessProjectId === projectId) throw new Error('Останови сборку или тестовый Minecraft перед удалением проекта.');
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Эта папка не является проектом NOVA.');
  const manifestPath = path.join(folder, 'src/main/resources/fabric.mod.json');
  JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!fs.existsSync(path.join(folder, 'build.gradle')) || !fs.existsSync(path.join(folder, 'gradle.properties'))) throw new Error('Папка проекта не прошла проверку.');
  await shell.trashItem(folder);
  return { deleted: true, id: projectId };
});
ipcMain.handle('dev:install', async (_event, { projectId }) => {
  const folder = projectPath(projectId);
  const props = fs.readFileSync(path.join(folder, 'gradle.properties'), 'utf8');
  const mcVersion = props.match(/^minecraft_version=(.+)$/m)?.[1]?.trim();
  if (!mcVersion) throw new Error('Не удалось определить версию Minecraft этого проекта.');
  safeSegment(mcVersion);
  const outputFolder = path.join(folder, 'build/libs');
  if (!fs.existsSync(outputFolder)) throw new Error('Сначала собери мод кнопкой «Собрать JAR».');
  const artifact = fs.readdirSync(outputFolder).filter(file => file.toLowerCase().endsWith('.jar') && !file.toLowerCase().includes('sources')).sort()[0];
  if (!artifact) throw new Error('Собери проект без ошибок — JAR пока не найден.');
  const modsFolder = path.join(profileRoot(mcVersion, 'fabric'), 'mods');
  fs.mkdirSync(modsFolder, { recursive: true });
  const destination = path.join(modsFolder, path.basename(artifact));
  fs.copyFileSync(path.join(outputFolder, artifact), destination);
  return { filename: artifact, mcVersion, folder: modsFolder };
});
let devProcess = null;
let devProcessProjectId = null;
function runDevTask(event, projectId, task) {
  const folder = projectPath(projectId);
  if (!fs.existsSync(path.join(folder, 'gradlew.bat'))) throw new Error('В проекте не найден Gradle Wrapper.');
  if (devProcess) throw new Error('Сборка или запуск уже выполняется.');
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `gradlew.bat ${task}`], { cwd: folder, windowsHide: true });
  devProcess = child;
  devProcessProjectId = projectId;
  const send = (kind, text) => { if (!event.sender.isDestroyed()) event.sender.send('launcher:event', { kind: 'dev-output', data: JSON.stringify({ kind, text: String(text) }) }); };
  child.stdout.on('data', data => send('log', data.toString('utf8')));
  child.stderr.on('data', data => send('error', data.toString('utf8')));
  child.on('error', error => { send('error', error.message); devProcess = null; devProcessProjectId = null; });
  child.on('close', code => { send('exit', code === 0 ? 'Задача завершена успешно.' : `Gradle завершился с кодом ${code}.`); devProcess = null; devProcessProjectId = null; });
  return true;
}
ipcMain.handle('dev:build', async (event, { projectId }) => runDevTask(event, projectId, 'build'));
ipcMain.handle('dev:run', async (event, { projectId }) => runDevTask(event, projectId, 'runClient'));
ipcMain.handle('dev:stop', async () => { if (!devProcess) return false; spawn('taskkill.exe', ['/pid', String(devProcess.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }); devProcess = null; return true; });
ipcMain.handle('dev:ai-status', async () => {
  try { const data = fs.existsSync(aiKeyFile()) ? JSON.parse(fs.readFileSync(aiKeyFile(), 'utf8')) : {}; return { openai: Boolean(data.openai), gemini: Boolean(data.gemini), anthropic: Boolean(data.anthropic) }; }
  catch { return { openai: false, gemini: false, anthropic: false }; }
});
ipcMain.handle('dev:ai-save', async (_event, keys) => { saveAiKeys(keys); return { saved: true }; });
ipcMain.handle('dev:ai-clear', async (_event, provider) => {
  if (!['openai', 'gemini', 'anthropic'].includes(provider)) throw new Error('Неизвестный AI-провайдер.');
  const data = fs.existsSync(aiKeyFile()) ? JSON.parse(fs.readFileSync(aiKeyFile(), 'utf8')) : {};
  delete data[provider];
  fs.mkdirSync(path.dirname(aiKeyFile()), { recursive: true });
  fs.writeFileSync(aiKeyFile(), JSON.stringify(data), { mode: 0o600 });
  return true;
});
ipcMain.handle('dev:models', async (_event, { provider }) => {
  if (!['openai', 'gemini', 'anthropic'].includes(provider)) throw new Error('Неизвестный AI-провайдер.');
  const key = readAiKey(provider);
  if (!key) throw new Error('Сначала сохрани API-ключ выбранной нейросети.');
  let url; let headers;
  if (provider === 'openai') { url = 'https://api.openai.com/v1/models'; headers = { Authorization: `Bearer ${key}` }; }
  else if (provider === 'gemini') { url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100'; headers = { 'x-goog-api-key': key }; }
  else { url = 'https://api.anthropic.com/v1/models?limit=100'; headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' }; }
  const response = await fetch(url, { headers });
  let data; try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error?.message || data.message || `Не удалось проверить API (${response.status}).`);
  let models;
  if (provider === 'openai') models = (data.data || []).map(item => item.id).filter(id => /^(gpt-|o\d|chatgpt-)/i.test(id) && !/(audio|transcribe|tts|embedding|moderation|image|realtime)/i.test(id));
  else if (provider === 'gemini') models = (data.models || []).filter(item => (item.supportedGenerationMethods || []).includes('generateContent')).map(item => item.name?.replace(/^models\//, '')).filter(Boolean);
  else models = (data.data || []).filter(item => item.lifecycle !== 'retired').map(item => item.id).filter(Boolean);
  return { models: [...new Set(models)].slice(0, 100) };
});
ipcMain.handle('dev:ai', async (_event, { provider, model, history, prompt, projectId, file, contents }) => {
  if (!['openai', 'gemini', 'anthropic'].includes(provider)) throw new Error('Неизвестный AI-провайдер.');
  const key = readAiKey(provider);
  if (!key) throw new Error('Сначала сохрани API-ключ выбранной нейросети.');
  if (typeof model !== 'string' || !/^[A-Za-z0-9_.:/-]{1,100}$/.test(model)) throw new Error('Укажи корректный ID модели.');
  const priorMessages = (Array.isArray(history) ? history : []).filter(item => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string').slice(-12).map(item => ({ role: item.role, content: item.content.slice(0, 5000) }));
  const userPrompt = `Проект Minecraft Fabric: ${String(projectId || '').slice(0, 60)}. Открытый файл: ${String(file || '').slice(0, 240)}.\nЗапрос пользователя: ${String(prompt || '').slice(0, 3000)}\nРаботай как помощник по коду: объясняй конкретно, показывай законченные фрагменты, отмечай дополнительные файлы и зависимости. Не говори, что сам изменил или сохранил файлы.\n\nСодержимое выбранного файла:\n${String(contents || '').slice(0, 14000)}`;
  priorMessages.push({ role: 'user', content: userPrompt });
  const systemPrompt = 'Ты NOVA Code Assistant, помощник по созданию модов Minecraft Java Edition на Fabric. Отвечай по-русски, если пользователь пишет по-русски. Предлагай код с указанием пути файла и объясняй, что заменить. Никогда не утверждай, что изменил файлы напрямую.';
  let response;
  if (provider === 'openai') {
    response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, instructions: systemPrompt, input: priorMessages.map(item => ({ role: item.role, content: item.content })), max_output_tokens: 3000 }) });
  } else if (provider === 'gemini') {
    const modelId = model.replace(/^models\//, '');
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents: priorMessages.map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] })), generationConfig: { maxOutputTokens: 3000 } }) });
  } else {
    response = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, system: systemPrompt, max_tokens: 3000, messages: priorMessages.map(item => ({ role: item.role, content: item.content })) }) });
  }
  let data; try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(data.error?.message || data.message || `API вернул ошибку ${response.status}. Проверь ключ, модель и доступ к API.`);
  const output = provider === 'openai' ? (data.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n') : provider === 'gemini' ? data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('\n') : data.content?.map(item => item.text || '').join('\n');
  if (!output) throw new Error('AI не вернул текстовый ответ.');
  return output;
});

ipcMain.handle('mods:search', async (_event, { query, mcVersion, loader, offset = 0 }) => {
  safeSegment(mcVersion);
  if (!['fabric', 'forge'].includes(loader)) throw new Error('Выбери Fabric или Forge, чтобы искать моды.');
  const facets = JSON.stringify([['project_type:mod'], [`versions:${mcVersion}`], [`categories:${loader}`]]);
  const params = new URLSearchParams({ query: String(query || '').slice(0, 100), facets, index: 'downloads', offset: String(Math.max(0, Math.min(10000, Number(offset) || 0))), limit: '24' });
  const result = await getJson(`${MODRINTH_API}/search?${params}`, 'Modrinth временно недоступен');
  return { hits: result.hits || [], total_hits: result.total_hits || 0 };
});

ipcMain.handle('mods:versions', async (_event, data) => getModrinthVersions(data.projectId, data.mcVersion, data.loader));

ipcMain.handle('mods:installed', async (_event, { mcVersion, loader }) => {
  safeSegment(mcVersion);
  if (!['fabric', 'forge'].includes(loader)) throw new Error('Выбери Fabric или Forge.');
  const folder = path.join(profileRoot(mcVersion, loader), 'mods');
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).map(entry => {
    const file = path.join(folder, entry.name);
    return { name: entry.name, size: fs.statSync(file).size };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
});

ipcMain.handle('mods:remove-installed', async (_event, { mcVersion, loader, filename }) => {
  safeSegment(mcVersion);
  if (!['fabric', 'forge'].includes(loader)) throw new Error('Выбери Fabric или Forge.');
  if (typeof filename !== 'string' || path.basename(filename) !== filename || !filename.toLowerCase().endsWith('.jar')) throw new Error('Некорректное имя файла мода.');
  const folder = path.resolve(profileRoot(mcVersion, loader), 'mods');
  const file = path.resolve(folder, filename);
  if (path.dirname(file) !== folder || !fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error('Файл мода не найден.');
  await shell.trashItem(file);
  return { removed: true, filename };
});

ipcMain.handle('mods:install', async (event, { versionId, mcVersion, loader }) => {
  if (!/^[A-Za-z0-9_-]{2,100}$/.test(versionId)) throw new Error('Некорректный идентификатор версии мода.');
  const version = await getJson(`${MODRINTH_API}/version/${encodeURIComponent(versionId)}`, 'Не удалось проверить версию мода');
  safeSegment(mcVersion);
  if (!version.game_versions?.includes(mcVersion) || !version.loaders?.includes(loader)) throw new Error('Эта версия мода не совместима с выбранной игрой и загрузчиком.');
  const sendProgress = progress => event.sender.send('launcher:event', { kind: 'mod-progress', data: JSON.stringify(progress) });
  return installModrinthVersion({ version, mcVersion, loader, onProgress: sendProgress });
});

ipcMain.handle('mods:curseforge-open', async () => {
  await shell.openExternal('https://www.curseforge.com/minecraft/search?class=mc-mods');
  return true;
});

ipcMain.handle('mods:import-curseforge', async (_event, { mcVersion, loader }) => {
  safeSegment(mcVersion);
  if (!['fabric', 'forge'].includes(loader)) throw new Error('Сначала выбери Fabric или Forge.');
  const result = await dialog.showOpenDialog(win, { title: 'Выбери скачанный мод CurseForge', properties: ['openFile'], filters: [{ name: 'Моды Minecraft', extensions: ['jar'] }] });
  if (result.canceled || !result.filePaths.length) return { canceled: true };
  const source = result.filePaths[0];
  const folder = path.join(profileRoot(mcVersion, loader), 'mods');
  fs.mkdirSync(folder, { recursive: true });
  const baseName = path.basename(source);
  let destination = path.join(folder, baseName);
  let suffix = 2;
  while (fs.existsSync(destination)) destination = path.join(folder, `${path.parse(baseName).name} (${suffix++}).jar`);
  fs.copyFileSync(source, destination);
  return { canceled: false, filename: path.basename(destination), folder };
});

ipcMain.handle('launcher:java', async () => {
  return detectJava();
});

ipcMain.handle('launcher:diagnostics', async (_event, { version, memory }) => {
  const java = await detectJava();
  const totalGb = Math.round(os.totalmem() / 1024 ** 3 * 10) / 10;
  const freeGb = Math.round(os.freemem() / 1024 ** 3 * 10) / 10;
  const requestedGb = Math.max(2, Math.min(16, Number(memory) || 4));
  const endpoints = [
    { name: 'Mojang', url: 'https://launchermeta.mojang.com/mc/game/version_manifest.json' },
    { name: 'Fabric', url: 'https://meta.fabricmc.net/v2/versions/game' },
    { name: 'Forge', url: 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml' },
    { name: 'Modrinth', url: 'https://api.modrinth.com/v2/tag/category' }
  ];
  let versionManifest = null;
  const services = await Promise.all(endpoints.map(async endpoint => {
    try {
      const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(5000), headers: MODRINTH_HEADERS });
      if (endpoint.name === 'Mojang' && response.ok) versionManifest = await response.json();
      return { name: endpoint.name, ok: response.ok, detail: response.ok ? 'Подключение работает' : `Ответ сервера ${response.status}` };
    } catch { return { name: endpoint.name, ok: false, detail: 'Нет соединения или сервер не ответил' }; }
  }));
  let requiredJava = null;
  if (version) {
    try {
      safeSegment(version);
      const entry = versionManifest?.versions?.find(item => item.id === version);
      if (entry) {
        const detailResponse = await fetch(entry.url, { signal: AbortSignal.timeout(5000) });
        if (detailResponse.ok) requiredJava = (await detailResponse.json()).javaVersion?.majorVersion || null;
      }
    } catch {}
  }
  return { java, memory: { totalGb, freeGb, requestedGb }, requiredJava, services };
});

ipcMain.handle('launcher:open-folder', async () => {
  const folder = gameRoot();
  fs.mkdirSync(folder, { recursive: true });
  const error = await shell.openPath(folder);
  if (error) throw new Error(`Не получилось открыть папку игры: ${error}`);
  return folder;
});

ipcMain.handle('launcher:stop', async () => {
  if (!gameProcess) return false;
  gameProcess.kill();
  return true;
});

ipcMain.handle('launcher:quit', async () => {
  if (gameProcess) gameProcess.kill();
  app.quit();
  return true;
});

ipcMain.handle('launcher:creator-channel', async () => {
  await shell.openExternal('https://www.youtube.com/channel/UCYH_YOegbMe-5alO7nsQQwQ');
  return true;
});

ipcMain.handle('dev:open-openai-billing', async () => {
  await shell.openExternal('https://platform.openai.com/settings/organization/billing/overview');
  return true;
});

ipcMain.handle('launcher:play', async (event, { name, version, memory, loader = 'vanilla', loaderVersion, forgeVersion }) => {
  if (launchInProgress || gameProcess || fabricInstallInProgress) throw new Error('Minecraft уже запускается или идёт установка компонентов.');
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Ник: 3–16 символов, только латиница, цифры и _.');
  if (typeof version !== 'string' || !version) throw new Error('Сначала выбери версию Minecraft.');
  safeSegment(version);
  if (!['vanilla', 'fabric', 'forge'].includes(loader)) throw new Error('Выбран неизвестный загрузчик.');
  if (loader !== 'vanilla' && !loaderVersion && loader === 'fabric') throw new Error('Сначала выбери версию Fabric.');
  launchInProgress = true;
  const digest = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  digest[6] = (digest[6] & 0x0f) | 0x30; digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  const uuid = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  const launcher = new Client();
  let downloadFailure = null;
  const send = (kind, data) => { if (win && !win.isDestroyed()) win.webContents.send('launcher:event', { kind, data: typeof data === 'string' ? data : JSON.stringify(data) }); };
  launcher.on('debug', line => {
    send('log', line);
    if (!downloadFailure && /Failed to download/i.test(String(line))) downloadFailure = String(line);
  });
  launcher.startMinecraft = function (args) {
    const child = spawn(launchJava, args, {
      cwd: this.options.overrides.cwd || this.options.root,
      detached: this.options.overrides.detached,
      windowsHide: process.platform === 'win32'
    });
    child.stdout.on('data', data => this.emit('data', data.toString('utf-8')));
    child.stderr.on('data', data => this.emit('data', data.toString('utf-8')));
    child.on('error', error => this.emit('error', error));
    child.on('close', code => this.emit('close', code));
    return child;
  };
  launcher.on('progress', data => send('progress', data));
  launcher.on('download-status', data => send('download', data));
  launcher.on('data', line => send('log', line));
  launcher.on('close', code => {
    gameProcess = null;
    discordGame = null;
    discordActivity();
    launchInProgress = false;
    send('close', code);
    if (code && code !== 0) send('error', `Minecraft завершился с кодом ${code}. Проверь Java, память и журнал запуска.`);
  });
  launcher.on('error', error => send('error', error?.message || String(error)));
  launcher.on('debug', line => {
    if (/Failed to download|Failed to start due to|Couldn't start Minecraft/i.test(String(line))) send('warning', line);
  });
  send('status', `Готовим Minecraft ${version} (${loader})…`);
  send('stage', { label: `Проверяем файлы Minecraft ${version}`, percent: 2 });
  let launchJava = process.platform === 'win32' ? 'javaw' : 'java';
  try {
  const java = await detectJava();
  if (!java.available) throw new Error('Java не найдена. Установи Java 21 для современных версий или Java 17 для Minecraft 1.18–1.20.4, затем перезапусти лаунчер.');
  launchJava = java.javawPath || (process.platform === 'win32' ? 'javaw' : 'java');
  const ram = Math.max(2, Math.min(16, Number(memory) || 4));
  fs.mkdirSync(gameRoot(), { recursive: true });
  const manifestResponse = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest.json');
  if (!manifestResponse.ok) throw new Error('Не удалось получить каталог версий. Проверь подключение к интернету.');
  const manifest = await manifestResponse.json();
  const versionEntry = manifest.versions.find(entry => entry.id === version);
  if (!versionEntry) throw new Error('Версия отсутствует в каталоге Mojang. Обнови список и попробуй ещё раз.');
  let requiredJava = null;
  try {
    const detailResponse = await fetch(versionEntry.url);
    if (detailResponse.ok) requiredJava = (await detailResponse.json()).javaVersion?.majorVersion || null;
  } catch {}
  if (requiredJava && java.major && java.major < requiredJava) {
    throw new Error(`Minecraft ${version} требует Java ${requiredJava}, а найдена Java ${java.major}. Установи нужную Java и попробуй ещё раз.`);
  }
  const versionType = versionEntry.type;
  send('stage', { label: 'Проверяем и скачиваем недостающие файлы…', percent: 5 });
  const instanceDirectory = profileRoot(version, loader);
  fs.mkdirSync(instanceDirectory, { recursive: true });
  const overrides = { gameDirectory: instanceDirectory };
  let fabricProfileId;
  let forgeInstaller;
  if (loader === 'fabric') {
    send('stage', { label: `Устанавливаем Fabric ${loaderVersion}…`, percent: 8 });
    const installed = await ensureFabricProfile(version, loaderVersion, versionEntry);
    fabricProfileId = installed.profileId;
    overrides.minecraftJar = installed.baseJar;
    send('stage', { label: 'Проверяем и устанавливаем Fabric API…', percent: 10 });
    await installFabricApi(version, progress => send('mod-progress', progress));
  }
  if (loader === 'forge') {
    const supported = await getForgeVersions(version);
    const chosen = forgeVersion && supported.includes(forgeVersion) ? forgeVersion : supported[0];
    if (!chosen) throw new Error(`Для Minecraft ${version} пока нет доступной сборки Forge.`);
    send('stage', { label: `Скачиваем установщик Forge ${chosen}…`, percent: 8 });
    const forgeName = `${version}-${chosen}`;
    forgeInstaller = path.join(gameRoot(), 'installers', `forge-${forgeName}-installer.jar`);
    if (!fs.existsSync(forgeInstaller)) {
      const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeName}/forge-${forgeName}-installer.jar`;
      let installerSha1 = {};
      try {
        const checksumResponse = await fetch(`${installerUrl}.sha1`);
        const checksumText = checksumResponse.ok ? await checksumResponse.text() : '';
        const checksum = checksumText.trim().match(/[a-f0-9]{40}/i)?.[0];
        if (checksum) installerSha1 = { sha1: checksum };
      } catch {}
      await downloadVerified(installerUrl, forgeInstaller, installerSha1);
    }
  }
  const child = await launcher.launch({
    authorization: { access_token: '0', client_token: '0', uuid, name, user_properties: '{}', meta: { type: 'mojang', demo: false } },
    root: gameRoot(),
    version: { number: version, type: versionType, ...(fabricProfileId ? { custom: fabricProfileId } : {}) },
    ...(forgeInstaller ? { forge: forgeInstaller } : {}),
    overrides,
    memory: { max: `${ram}G`, min: '1G' },
    customLaunchArgs: ['--versionType', 'NOVA Launcher']
  });
  if (!child || typeof child.on !== 'function') throw new Error('Не удалось подготовить Minecraft. Лаунчер не получил игровой процесс: проверь подключение к серверам Mojang и журнал запуска.');
  if (downloadFailure) {
    child.kill();
    throw new Error(`Не удалось скачать обязательный файл игры. Проверь подключение к интернету и повтори запуск. Подробности: ${downloadFailure.slice(0, 220)}`);
  }
  gameProcess = child;
  discordGame = { name, version, loader: loader === 'vanilla' ? 'Vanilla' : loader === 'fabric' ? 'Fabric' : 'Forge', startedAt: Date.now() };
  discordActivity();
  send('stage', { label: 'Minecraft запущен. Приятной игры!', percent: 100 });
  send('status', 'Игра запущена! Хорошего приключения ✦');
  return true;
  } catch (error) {
    launchInProgress = false;
    send('launch-failed', error.message || String(error));
    throw error;
  }
});
