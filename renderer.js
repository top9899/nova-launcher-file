const $ = id => document.getElementById(id);
const select = $('version-select');
const username = $('username');
const modalBackdrop = $('modal-backdrop');
const modalBody = $('modal-body');
let versions = [];
let toastTimer;
const launcherLog = [];
let versionFilter = 'all';
let gameRunning = false;
let devBusyReset = null;
let devSaveOnClose = null;
let installedFabricVersions = new Set();

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 4000);
}

function addLauncherLog(kind, value) {
  const text = String(typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/Bearer\s+\S+/gi, 'Bearer [скрыто]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-[скрыто]').slice(0, 2000);
  launcherLog.push(`[${new Date().toLocaleTimeString('ru-RU', { hour12: false })}] [${String(kind).toUpperCase()}] ${text}`);
  if (launcherLog.length > 600) launcherLog.splice(0, launcherLog.length - 600);
}

function openLaunchLog() {
  const wrap = document.createElement('div'); wrap.className = 'launch-log';
  const description = document.createElement('p'); description.className = 'settings-help'; description.textContent = 'Журнал хранится в памяти до закрытия лаунчера. Скопируй его, если нужна помощь с запуском.';
  const actions = document.createElement('div'); actions.className = 'launch-log-actions';
  const copy = devButton('Скопировать журнал', 'dev-secondary');
  const clear = devButton('Очистить', 'dev-secondary');
  const output = document.createElement('pre'); output.className = 'launch-log-output';
  const refresh = () => { output.textContent = launcherLog.length ? launcherLog.join('\n') : 'Записей пока нет. Начни запуск Minecraft, чтобы увидеть ход подготовки и сообщения об ошибках.'; output.scrollTop = output.scrollHeight; };
  copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(launcherLog.join('\n')); toast('Журнал скопирован.'); } catch { toast('Не удалось скопировать журнал.'); } });
  clear.addEventListener('click', () => { launcherLog.length = 0; refresh(); });
  actions.append(copy, clear); wrap.append(description, actions, output); refresh(); openModal('Журнал запуска', wrap);
}

function setName(name, quiet = false) {
  name = name.trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) {
    if (!quiet) toast('Ник должен содержать 3–16 латинских букв, цифр или _.');
    username.focus();
    return false;
  }
  localStorage.setItem('nova-username', name);
  const recentNames = (() => { try { return JSON.parse(localStorage.getItem('nova-recent-usernames') || '[]'); } catch { return []; } })();
  const names = [name, ...recentNames.filter(item => item !== name && /^[A-Za-z0-9_]{3,16}$/.test(item))].slice(0, 5);
  localStorage.setItem('nova-recent-usernames', JSON.stringify(names));
  $('username-suggestions').replaceChildren(...names.map(value => new Option(value, value)));
  username.value = name;
  $('account-name').textContent = name;
  $('avatar-small').textContent = name[0].toUpperCase();
  $('avatar-top').textContent = name[0].toUpperCase();
  $('profile-avatar').textContent = name[0].toUpperCase();
  if (!quiet) toast(`Профиль «${name}» сохранён`);
  return true;
}

function syncVersion() {
  const version = select.value;
  if (!version) return;
  localStorage.setItem('nova-version', version);
  $('selected-version-title').textContent = `Minecraft ${version}`;
  $('art-version').textContent = version;
  const data = versions.find(item => item.id === version);
  const kind = data?.type || 'release';
  const labels = { release: 'RELEASE', snapshot: 'SNAPSHOT', old_beta: 'BETA', old_alpha: 'ALPHA' };
  document.querySelector('.release-pill').textContent = labels[kind] || kind.toUpperCase();
  const info = document.querySelector('.version-details p');
  info.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'green-dot';
  const separator = document.createElement('span');
  separator.className = 'separator';
  separator.textContent = ' · ';
  info.append(dot, document.createTextNode(kind === 'release' ? ' Официальный релиз' : ' Тестовая версия'), separator, document.createTextNode('Java Edition'));
}

function closeModal() {
  if ($('modal-title').textContent === 'NOVA Studio') devSaveOnClose?.();
  modalBackdrop.hidden = true;
  document.querySelector('.modal').classList.remove('modal-wide');
  modalBody.replaceChildren();
}

function openModal(title, content) {
  $('modal-title').textContent = title;
  document.querySelector('.modal').classList.toggle('modal-wide', content.classList.contains('dev-workbench') || content.classList.contains('dev-home'));
  modalBody.replaceChildren(content);
  modalBackdrop.hidden = false;
}

function versionRow(version) {
  const wrap = document.createElement('div');
  wrap.className = 'version-row-wrap';
  const row = document.createElement('button');
  row.className = `version-row${version.id === select.value ? ' selected' : ''}`;
  const main = document.createElement('span');
  main.className = 'version-row-main';
  const name = document.createElement('strong');
  name.textContent = version.id;
  const sub = document.createElement('small');
  const types = { release: 'Релиз', snapshot: 'Снапшот', old_beta: 'Бета', old_alpha: 'Альфа' };
  sub.textContent = `${types[version.type] || version.type} · ${version.releaseTime?.slice(0, 10) || ''}${installedFabricVersions.has(version.id) ? ' · Fabric установлен' : ''}`;
  main.append(name, sub);
  const action = document.createElement('span');
  action.className = 'version-row-action';
  action.textContent = version.id === select.value ? 'Выбрана' : 'Выбрать';
  row.append(main, action);
  row.addEventListener('click', () => {
    select.value = version.id;
    syncVersion();
    closeModal();
    $('launch-status').textContent = `Выбрана версия ${version.id}`;
  });
  const fabric = document.createElement('button');
  fabric.className = `version-fabric-action${installedFabricVersions.has(version.id) ? ' ready' : ''}`;
  fabric.textContent = installedFabricVersions.has(version.id) ? 'Fabric ✓' : '＋ Fabric';
  fabric.title = `Добавить Fabric к Minecraft ${version.id}`;
  fabric.addEventListener('click', async event => {
    event.stopPropagation();
    fabric.disabled = true; fabric.textContent = 'Установка…';
    try {
      toast(`Подготавливаем Fabric для Minecraft ${version.id}…`);
      const result = await window.nova.installFabric(version.id);
      installedFabricVersions.add(version.id);
      select.value = version.id; syncVersion(); $('loader-select').value = 'fabric';
      await loadLoaderVersions();
      if ([...$('loader-version-select').options].some(option => option.value === result.loaderVersion)) $('loader-version-select').value = result.loaderVersion;
      const activeList = modalBody.querySelector('.version-list');
      if (activeList) renderVersionList(activeList, modalBody.querySelector('.version-search')?.value || '');
      if (!modalBackdrop.hidden && $('modal-title').textContent === 'Библиотека версий') closeModal();
      $('launch-status').textContent = `Fabric готов для Minecraft ${version.id}`;
      toast(`Fabric ${result.loaderVersion} добавлен к версии ${version.id}.`);
    } catch (error) {
      fabric.disabled = false; fabric.textContent = installedFabricVersions.has(version.id) ? 'Fabric ✓' : '＋ Fabric';
      toast(error.message || `Не удалось добавить Fabric к ${version.id}.`);
    }
  });
  wrap.append(row, fabric);
  return wrap;
}

function renderVersionList(list, query = '') {
  list.replaceChildren();
  const term = query.trim().toLowerCase();
  const found = versions.filter(version => {
    const snapshots = localStorage.getItem('nova-show-snapshots') === 'true';
    const oldVersions = localStorage.getItem('nova-show-old-versions') === 'true';
    const typeMatch = versionFilter === 'all'
      ? version.type === 'release' || (snapshots && version.type === 'snapshot') || (oldVersions && version.type.startsWith('old_'))
      : versionFilter === 'snapshot' ? snapshots && version.type === 'snapshot'
      : versionFilter === 'old' ? oldVersions && version.type.startsWith('old_')
      : version.type === versionFilter;
    return typeMatch && (!term || version.id.toLowerCase().includes(term));
  });
  if (!found.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-versions';
    empty.textContent = 'Подходящих версий не найдено';
    list.append(empty);
    return;
  }
  for (const version of found) list.append(versionRow(version));
}

function openVersions() {
  if (!versions.length) {
    loadVersions().then(() => versions.length && openVersions());
    toast('Подключаемся к каталогу версий…');
    return;
  }
  versionFilter = 'all';
  const wrap = document.createElement('div');
  const search = document.createElement('input');
  search.className = 'version-search';
  search.placeholder = 'Найти версию, например 1.20.1';
  search.autocomplete = 'off';
  const filters = document.createElement('div');
  filters.className = 'version-filters';
  const list = document.createElement('div');
  list.className = 'version-list';
  const choices = [['all', 'Включённые'], ['release', 'Релизы'], ['snapshot', 'Снапшоты'], ['old', 'Бета и альфа']];
  for (const [value, label] of choices) {
    const chip = document.createElement('button');
    chip.className = `filter-chip${value === versionFilter ? ' active' : ''}`;
    chip.textContent = label;
    chip.addEventListener('click', () => {
      versionFilter = value;
      filters.querySelectorAll('.filter-chip').forEach(button => button.classList.toggle('active', button === chip));
      renderVersionList(list, search.value);
    });
    filters.append(chip);
  }
  const toggles = document.createElement('div');
  toggles.className = 'version-toggles';
  for (const [key, label] of [['nova-show-snapshots', 'Показывать снапшоты'], ['nova-show-old-versions', 'Показывать альфа и бета-версии']]) {
    const toggleLabel = document.createElement('label');
    toggleLabel.className = 'version-toggle-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = localStorage.getItem(key) === 'true';
    const text = document.createElement('span');
    text.textContent = label;
    checkbox.addEventListener('change', () => {
      localStorage.setItem(key, String(checkbox.checked));
      renderVersionList(list, search.value);
    });
    toggleLabel.append(checkbox, text);
    toggles.append(toggleLabel);
  }
  search.addEventListener('input', () => renderVersionList(list, search.value));
  wrap.append(search, toggles, filters, list);
  renderVersionList(list);
  openModal('Библиотека версий', wrap);
  window.nova.installedProfiles().then(profiles => {
    installedFabricVersions = new Set(profiles.filter(profile => profile.loader === 'fabric').map(profile => profile.gameVersion));
    renderVersionList(list, search.value);
  }).catch(() => {});
  search.focus();
}

async function loadLoaderVersions() {
  const loader = $('loader-select').value;
  const versionSelect = $('loader-version-select');
  versionSelect.onchange = () => { if (versionSelect.value) localStorage.setItem(`nova-loader-version:${loader}:${select.value}`, versionSelect.value); };
  versionSelect.replaceChildren();
  versionSelect.hidden = loader === 'vanilla';
  if (loader === 'vanilla' || !select.value) return;
  versionSelect.add(new Option('Загрузка версий…', ''));
  try {
    const versionsForLoader = loader === 'fabric'
      ? await window.nova.fabricVersions(select.value)
      : await window.nova.forgeVersions(select.value);
    versionSelect.replaceChildren();
    if (!versionsForLoader.length) {
      versionSelect.add(new Option('Нет сборок для этой версии', ''));
      return;
    }
    for (const item of versionsForLoader) {
      const value = typeof item === 'string' ? item : item.version;
      const label = typeof item === 'string' ? item : `${item.version}${item.stable ? ' · стабильная' : ''}`;
      versionSelect.add(new Option(label, value));
    }
    const remembered = localStorage.getItem(`nova-loader-version:${loader}:${select.value}`);
    if (remembered && [...versionSelect.options].some(option => option.value === remembered)) versionSelect.value = remembered;
    else if (loader === 'fabric') {
      const stable = versionsForLoader.find(item => item.stable);
      if (stable) versionSelect.value = stable.version;
    }
  } catch (error) {
    versionSelect.replaceChildren(new Option('Не удалось получить версии', ''));
    toast(error.message || `Не удалось загрузить список ${loader}.`);
  }
}

function syncModTarget(mcVersion, loader) {
  if (mcVersion && [...select.options].some(option => option.value === mcVersion)) select.value = mcVersion;
  if (loader && ['fabric', 'forge'].includes(loader)) $('loader-select').value = loader;
  syncVersion();
  loadLoaderVersions();
}

function openCurseForgePanel(target) {
  const wrap = document.createElement('div');
  const intro = document.createElement('p');
  intro.className = 'settings-help';
  intro.textContent = 'Открой каталог CurseForge, скачай файл мода для выбранной версии Minecraft и загрузчика, затем импортируй файл .jar в профиль NOVA.';
  const warning = document.createElement('div');
  warning.className = 'curseforge-note';
  warning.textContent = 'CurseForge требует API-ключ для прямой загрузки модов сторонним приложением. Поэтому сайт открывается отдельно, а скачанный .jar можно импортировать сюда.';
  const actions = document.createElement('div');
  actions.className = 'mods-actions';
  const openSite = document.createElement('button');
  openSite.className = 'settings-folder-button';
  openSite.textContent = 'Открыть CurseForge ↗';
  openSite.addEventListener('click', async () => {
    try { await window.nova.openCurseForge(); }
    catch (error) { toast(error.message || 'Не получилось открыть CurseForge.'); }
  });
  const importFile = document.createElement('button');
  importFile.className = 'settings-folder-button';
  importFile.textContent = 'Импортировать .jar';
  importFile.addEventListener('click', async () => {
    try {
      const result = await window.nova.importCurseForge(target);
      if (!result.canceled) toast(`Добавлен ${result.filename} в профиль ${target.mcVersion} / ${target.loader}.`);
    } catch (error) { toast(error.message || 'Не удалось импортировать мод.'); }
  });
  actions.append(openSite, importFile);
  wrap.append(intro, warning, actions);
  openModal('Моды CurseForge', wrap);
}

function openMods() {
  if (!versions.length) {
    loadVersions().then(() => versions.length && openMods());
    toast('Загружаем каталог версий…');
    return;
  }
  const wrap = document.createElement('div');
  const tabs = document.createElement('div');
  tabs.className = 'mod-platform-tabs';
  const modrinthTab = document.createElement('button');
  modrinthTab.className = 'platform-tab active';
  modrinthTab.textContent = 'Modrinth';
  const curseforgeTab = document.createElement('button');
  curseforgeTab.className = 'platform-tab';
  curseforgeTab.textContent = 'CurseForge';
  const installedTab = document.createElement('button');
  installedTab.className = 'platform-tab';
  installedTab.textContent = 'Установленные';
  tabs.append(modrinthTab, curseforgeTab, installedTab);
  const controls = document.createElement('div');
  controls.className = 'mods-controls';
  const gameSelect = document.createElement('select');
  gameSelect.className = 'settings-select';
  for (const version of versions.filter(item => item.type === 'release')) gameSelect.add(new Option(version.id, version.id));
  gameSelect.value = select.value && [...gameSelect.options].some(option => option.value === select.value) ? select.value : gameSelect.options[0]?.value;
  const modLoader = document.createElement('select');
  modLoader.className = 'settings-select';
  modLoader.add(new Option('Fabric', 'fabric'));
  modLoader.add(new Option('Forge', 'forge'));
  modLoader.value = ['fabric', 'forge'].includes($('loader-select').value) ? $('loader-select').value : 'fabric';
  controls.append(gameSelect, modLoader);
  const search = document.createElement('input');
  search.className = 'version-search mod-search';
  search.placeholder = 'Поиск модов: Sodium, JEI, minimap…';
  search.autocomplete = 'off';
  const summary = document.createElement('div');
  summary.className = 'mods-summary';
  summary.textContent = 'Моды совместимые с выбранной версией и загрузчиком';
  const results = document.createElement('div');
  results.className = 'mod-results';
  let requestNumber = 0;
  let view = 'catalog';
  let target = { mcVersion: gameSelect.value, loader: modLoader.value };
  let timer;

  const loadCatalog = async () => {
    view = 'catalog'; search.hidden = false; search.placeholder = 'Поиск модов: Sodium, JEI, minimap…';
    const currentRequest = ++requestNumber;
    target = { mcVersion: gameSelect.value, loader: modLoader.value };
    if (select.value !== target.mcVersion || $('loader-select').value !== target.loader) syncModTarget(target.mcVersion, target.loader);
    results.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'empty-versions';
    loading.textContent = 'Ищем моды в каталоге Modrinth…';
    results.append(loading);
    try {
      const response = await window.nova.searchMods({ query: search.value, mcVersion: target.mcVersion, loader: target.loader });
      if (currentRequest !== requestNumber) return;
      results.replaceChildren();
      summary.textContent = `${Number(response.total_hits).toLocaleString('ru-RU')} модов · Minecraft ${target.mcVersion} · ${target.loader}`;
      if (!response.hits.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-versions';
        empty.textContent = 'Ничего не нашлось. Попробуй другое название или версию игры.';
        results.append(empty);
        return;
      }
      for (const project of response.hits) {
        const card = document.createElement('article');
        card.className = 'mod-card';
        if (project.icon_url) {
          const icon = document.createElement('img');
          icon.className = 'mod-icon';
          icon.src = project.icon_url;
          icon.alt = '';
          card.append(icon);
        } else {
          const fallback = document.createElement('div');
          fallback.className = 'mod-icon mod-icon-fallback';
          fallback.textContent = '✧';
          card.append(fallback);
        }
        const text = document.createElement('div');
        text.className = 'mod-card-text';
        const name = document.createElement('strong');
        name.textContent = project.title;
        const author = document.createElement('small');
        author.textContent = `от ${project.author} · ${Number(project.downloads || 0).toLocaleString('ru-RU')} загрузок`;
        const description = document.createElement('p');
        description.textContent = project.description || 'Описание не указано.';
        text.append(name, author, description);
        const choose = document.createElement('button');
        choose.className = 'mod-install-button';
        choose.textContent = 'Выбрать версию';
        choose.addEventListener('click', () => openModVersions(project, target));
        card.append(text, choose);
        results.append(card);
      }
    } catch (error) {
      if (currentRequest !== requestNumber) return;
      results.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'empty-versions';
      empty.textContent = error.message || 'Modrinth сейчас недоступен.';
      results.append(empty);
    }
  };

  const loadInstalled = async () => {
    view = 'installed'; search.hidden = false; search.placeholder = 'Поиск установленных модов…';
    const currentRequest = ++requestNumber;
    target = { mcVersion: gameSelect.value, loader: modLoader.value };
    if (select.value !== target.mcVersion || $('loader-select').value !== target.loader) syncModTarget(target.mcVersion, target.loader);
    results.replaceChildren();
    const loading = document.createElement('div'); loading.className = 'empty-versions'; loading.textContent = 'Загружаем список установленных модов…'; results.append(loading);
    try {
      const mods = await window.nova.installedMods(target);
      if (currentRequest !== requestNumber) return;
      const query = search.value.trim().toLocaleLowerCase();
      const filtered = mods.filter(mod => !query || mod.name.toLocaleLowerCase().includes(query));
      summary.textContent = `${mods.length} модов · Minecraft ${target.mcVersion} · ${target.loader}`;
      results.replaceChildren();
      if (!filtered.length) { const empty = document.createElement('div'); empty.className = 'empty-versions'; empty.textContent = mods.length ? 'По этому запросу модов нет.' : 'Для этой сборки ещё не установлены моды.'; results.append(empty); return; }
      for (const mod of filtered) {
        const row = document.createElement('article'); row.className = 'installed-mod-row';
        const info = document.createElement('div'); info.className = 'installed-mod-info';
        const name = document.createElement('strong'); name.textContent = mod.name;
        const size = document.createElement('small'); size.textContent = `${(mod.size / 1024 / 1024).toFixed(1)} МБ`;
        info.append(name, size);
        const remove = document.createElement('button'); remove.className = 'mod-remove-button'; remove.textContent = 'В Корзину';
        remove.addEventListener('click', async () => {
          remove.disabled = true; remove.textContent = 'Перемещаем…';
          try { await window.nova.removeInstalledMod({ ...target, filename: mod.name }); toast(`«${mod.name}» перемещён в Корзину Windows.`); await loadInstalled(); }
          catch (error) { remove.disabled = false; remove.textContent = 'В Корзину'; toast(error.message || 'Не удалось удалить мод.'); }
        });
        row.append(info, remove); results.append(row);
      }
    } catch (error) { if (currentRequest === requestNumber) { results.replaceChildren(); const empty = document.createElement('div'); empty.className = 'empty-versions'; empty.textContent = error.message || 'Не удалось прочитать папку модов.'; results.append(empty); } }
  };

  modrinthTab.addEventListener('click', () => {
    modrinthTab.classList.add('active'); curseforgeTab.classList.remove('active'); installedTab.classList.remove('active');
    openModal('Каталог модов', wrap);
    loadCatalog();
  });
  curseforgeTab.addEventListener('click', () => {
    modrinthTab.classList.remove('active'); curseforgeTab.classList.add('active'); installedTab.classList.remove('active');
    openCurseForgePanel(target);
  });
  installedTab.addEventListener('click', () => {
    modrinthTab.classList.remove('active'); curseforgeTab.classList.remove('active'); installedTab.classList.add('active');
    openModal('Каталог модов', wrap); loadInstalled();
  });
  gameSelect.addEventListener('change', () => view === 'installed' ? loadInstalled() : loadCatalog());
  modLoader.addEventListener('change', () => view === 'installed' ? loadInstalled() : loadCatalog());
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => view === 'installed' ? loadInstalled() : loadCatalog(), view === 'installed' ? 80 : 300); });
  wrap.append(tabs, controls, search, summary, results);
  openModal('Каталог модов', wrap);
  loadCatalog();
}

async function openModVersions(project, target) {
  const wrap = document.createElement('div');
  const back = document.createElement('button');
  back.className = 'back-link';
  back.textContent = '← Вернуться к каталогу';
  back.addEventListener('click', openMods);
  const details = document.createElement('p');
  details.className = 'settings-help';
  details.textContent = `${project.title} · Minecraft ${target.mcVersion} · ${target.loader}`;
  const progress = document.createElement('div');
  progress.className = 'mod-install-progress';
  progress.id = 'mod-install-progress';
  progress.textContent = '';
  const list = document.createElement('div');
  list.className = 'mod-version-list';
  list.textContent = 'Загружаем совместимые версии…';
  wrap.append(back, details, progress, list);
  openModal(`Версии: ${project.title}`, wrap);
  try {
    const versionsForMod = await window.nova.modVersions({ projectId: project.project_id, mcVersion: target.mcVersion, loader: target.loader });
    list.replaceChildren();
    if (!versionsForMod.length) {
      list.textContent = 'Нет подходящих версий для этого профиля.';
      return;
    }
    for (const modVersion of versionsForMod) {
      const row = document.createElement('div');
      row.className = 'mod-version-row';
      const info = document.createElement('div');
      const versionName = document.createElement('strong');
      versionName.textContent = modVersion.version_number;
      const meta = document.createElement('small');
      meta.textContent = `${modVersion.version_type} · ${modVersion.date_published?.slice(0, 10) || ''}`;
      info.append(versionName, meta);
      const install = document.createElement('button');
      install.className = 'mod-install-button';
      install.textContent = 'Установить';
      install.addEventListener('click', async () => {
        install.disabled = true;
        install.textContent = 'Скачиваем…';
        try {
          syncModTarget(target.mcVersion, target.loader);
          const result = await window.nova.installMod({ versionId: modVersion.id, mcVersion: target.mcVersion, loader: target.loader });
          install.textContent = 'Установлено ✓';
          toast(`Установлено файлов: ${result.installed}. Мод будет в профиле ${target.mcVersion} / ${target.loader}.`);
        } catch (error) {
          install.disabled = false;
          install.textContent = 'Повторить';
          toast(error.message || 'Не удалось установить мод.');
        }
      });
      row.append(info, install);
      list.append(row);
    }
  } catch (error) {
    list.textContent = error.message || 'Не удалось получить версии мода.';
  }
}

async function openDevMode() {
  const wrap = document.createElement('div');
  wrap.className = 'dev-home';
  const intro = document.createElement('div');
  intro.className = 'dev-welcome';
  intro.innerHTML = '<span class="dev-orb">⌘</span><div><div class="section-kicker">NOVA STUDIO</div><h3>Создавай свои моды</h3><p>Пиши Java-код, собирай проект и запускай тестовый Minecraft прямо из лаунчера.</p></div>';
  const projectList = document.createElement('div');
  projectList.className = 'dev-project-list';
  const createButton = document.createElement('button');
  createButton.className = 'hero-cta dev-create-button';
  createButton.textContent = '＋ Новый Fabric-проект';
  const openExisting = async project => openDevEditor(project);
  createButton.addEventListener('click', async () => {
    const form = document.createElement('div');
    form.className = 'dev-new-project';
    const title = document.createElement('h3'); title.textContent = 'Новый мод';
    const nameInput = document.createElement('input'); nameInput.className = 'version-search'; nameInput.placeholder = 'Название мода'; nameInput.value = 'Мой первый мод';
    const idInput = document.createElement('input'); idInput.className = 'version-search'; idInput.placeholder = 'mod_id'; idInput.value = 'my_first_mod';
    const packageInput = document.createElement('input'); packageInput.className = 'version-search'; packageInput.placeholder = 'dev.example.mymod'; packageInput.value = 'dev.nova.myfirstmod';
    const versionSelect = document.createElement('select'); versionSelect.className = 'settings-select'; versionSelect.add(new Option('Загружаем версии…', ''));
    const create = document.createElement('button'); create.className = 'hero-cta'; create.textContent = 'Создать проект';
    const info = document.createElement('p'); info.className = 'settings-help'; info.textContent = 'Создаст проект Fabric с Fabric API и Gradle Wrapper. При первом запуске Gradle загрузит Minecraft и библиотеки для разработки.';
    const updateId = () => { idInput.value = nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'my_mod'; packageInput.value = `dev.nova.${idInput.value.replace(/_/g, '')}`; };
    nameInput.addEventListener('input', updateId);
    form.append(title, fieldLabel('Название мода', nameInput), fieldLabel('ID мода', idInput), fieldLabel('Java-пакет', packageInput), fieldLabel('Версия Minecraft', versionSelect), info, create);
    openModal('Создать проект', form);
    try {
      const devVersions = await window.nova.devVersions();
      versionSelect.replaceChildren(...devVersions.map(version => new Option(version, version)));
      versionSelect.value = select.value && devVersions.includes(select.value) ? select.value : devVersions[0];
    } catch (error) { versionSelect.replaceChildren(new Option(error.message || 'Каталог версий недоступен', '')); }
    create.addEventListener('click', async () => {
      create.disabled = true; create.textContent = 'Подготовка проекта…';
      try {
        const project = await window.nova.devCreate({ name: nameInput.value.trim(), projectId: idInput.value.trim(), packageName: packageInput.value.trim(), mcVersion: versionSelect.value });
        toast(`Проект «${project.title}» создан. Файлы Gradle готовы.`);
        await openDevEditor(project);
      } catch (error) { create.disabled = false; create.textContent = 'Создать проект'; toast(error.message || 'Не удалось создать проект.'); }
    });
  });
  wrap.append(intro, createButton, projectList);
  openModal('Режим разработки', wrap);
  try {
    const projects = await window.nova.devProjects();
    if (!projects.length) { const empty = document.createElement('div'); empty.className = 'empty-versions'; empty.textContent = 'Пока нет проектов. Создай первый Fabric-мод — шаблон уже будет готов к сборке.'; projectList.append(empty); }
    for (const project of projects) {
      const card = document.createElement('div'); card.className = 'dev-project-card';
      const open = document.createElement('button'); open.className = 'dev-project-open'; open.innerHTML = `<span class="dev-project-icon">✦</span><span><strong></strong><small></small></span><span class="nav-arrow">›</span>`;
      open.querySelector('strong').textContent = project.title || project.id;
      open.querySelector('small').textContent = project.folder || project.id; open.title = project.folder || project.id;
      open.addEventListener('click', () => openExisting(project));
      const remove = devButton('×', 'dev-project-delete'); remove.title = 'Удалить проект'; remove.setAttribute('aria-label', `Удалить проект ${project.title || project.id}`);
      remove.addEventListener('click', () => confirmDeleteProject(project, openDevMode));
      card.append(open, remove); projectList.append(card);
    }
  } catch (error) { toast(error.message || 'Не удалось загрузить проекты.'); }
}

function fieldLabel(label, control) {
  const wrap = document.createElement('label'); wrap.className = 'dev-field-label';
  const caption = document.createElement('span'); caption.textContent = label; wrap.append(caption, control); return wrap;
}

function confirmDeleteProject(project, afterDelete) {
  const wrap = document.createElement('div'); wrap.className = 'dev-delete-confirm';
  const icon = document.createElement('div'); icon.className = 'dev-delete-warning'; icon.textContent = '⌫';
  const title = document.createElement('h3'); title.textContent = 'Удалить проект?';
  const text = document.createElement('p'); text.textContent = `«${project.title || project.id}» и его файлы переместятся в Корзину Windows — их можно будет восстановить.`;
  const actions = document.createElement('div'); actions.className = 'dev-delete-actions';
  const cancel = devButton('Оставить проект', 'dev-secondary');
  const confirm = devButton('Переместить в Корзину', 'dev-danger');
  cancel.addEventListener('click', closeModal);
  confirm.addEventListener('click', async () => {
    confirm.disabled = true; confirm.textContent = 'Удаляем…';
    try { await window.nova.devDelete({ projectId: project.id }); closeModal(); toast('Проект перемещён в Корзину Windows.'); await afterDelete(); }
    catch (error) { confirm.disabled = false; confirm.textContent = 'Переместить в Корзину'; toast(error.message || 'Не удалось удалить проект.'); }
  });
  actions.append(cancel, confirm); wrap.append(icon, title, text, actions); openModal('Удаление проекта', wrap);
}

async function openDevEditor(project) {
  devSaveOnClose = null;
  const wrap = document.createElement('div'); wrap.className = 'dev-workbench';
  const toolbar = document.createElement('div'); toolbar.className = 'dev-toolbar';
  const name = document.createElement('div'); name.className = 'dev-project-name'; name.innerHTML = '<span class="dev-orb">✦</span><span><strong></strong><small></small></span>';
  name.querySelector('strong').textContent = project.title || project.id;
  name.querySelector('small').textContent = `Fabric · Minecraft ${project.mcVersion || 'проект'}`;
  name.title = project.folder || project.id;
  const actions = document.createElement('div'); actions.className = 'dev-actions';
  const back = devButton('← Проекты', 'dev-secondary');
  const openFolder = devButton('Открыть папку ↗', 'dev-secondary');
  const save = devButton('Сохранить', 'dev-secondary');
  const build = devButton('Собрать JAR', 'dev-secondary');
  const installMod = devButton('В папку модов', 'dev-secondary');
  const newFile = devButton('＋ Файл', 'dev-secondary');
  const newFolder = devButton('＋ Папка', 'dev-secondary');
  const run = devButton('▶ Запустить мод', 'dev-run');
  const stop = devButton('■ Стоп', 'dev-secondary');
  const removeProject = devButton('Удалить проект', 'dev-danger');
  save.classList.add('dev-save-action');
  actions.append(back, openFolder, newFile, newFolder, save, build, installMod, run, stop, removeProject); toolbar.append(name, actions);
  const locationBar = document.createElement('div'); locationBar.className = 'dev-location-bar';
  const locationIcon = document.createElement('span'); locationIcon.textContent = '⌖';
  const locationText = document.createElement('code'); locationText.textContent = project.folder || project.id; locationText.title = project.folder || project.id;
  locationBar.append(locationIcon, locationText);
  const layout = document.createElement('div'); layout.className = 'dev-layout';
  const editorPane = document.createElement('div'); editorPane.className = 'dev-editor-pane';
  const tabs = document.createElement('div'); tabs.className = 'dev-file-tabs';
  const findBar = document.createElement('div'); findBar.className = 'dev-findbar'; findBar.hidden = true;
  const findRow = document.createElement('div'); findRow.className = 'dev-find-row';
  const findInput = document.createElement('input'); findInput.className = 'dev-find-input'; findInput.placeholder = 'Найти в файле'; findInput.setAttribute('aria-label', 'Найти в файле');
  const findCount = document.createElement('span'); findCount.className = 'dev-find-count'; findCount.textContent = '0 / 0';
  const previousMatch = devButton('↑', 'dev-find-button'); previousMatch.title = 'Предыдущее совпадение · Shift+Enter';
  const nextMatch = devButton('↓', 'dev-find-button'); nextMatch.title = 'Следующее совпадение · Enter';
  const toggleReplace = devButton('Заменить', 'dev-find-button');
  const closeFind = devButton('×', 'dev-find-button'); closeFind.title = 'Закрыть поиск · Escape';
  findRow.append(findInput, findCount, previousMatch, nextMatch, toggleReplace, closeFind);
  const replaceRow = document.createElement('div'); replaceRow.className = 'dev-find-row dev-replace-row'; replaceRow.hidden = true;
  const replaceInput = document.createElement('input'); replaceInput.className = 'dev-find-input'; replaceInput.placeholder = 'Заменить на'; replaceInput.setAttribute('aria-label', 'Заменить на');
  const replaceOne = devButton('Заменить', 'dev-find-button');
  const replaceAll = devButton('Заменить всё', 'dev-find-button');
  replaceRow.append(replaceInput, replaceOne, replaceAll);
  findBar.append(findRow, replaceRow);
  const editor = document.createElement('textarea'); editor.className = 'code-editor'; editor.spellcheck = false; editor.wrap = 'off'; editor.setAttribute('aria-label', 'Редактор кода Java');
  const status = document.createElement('div'); status.className = 'dev-status'; status.textContent = 'Выбери файл проекта слева.';
  const filesPane = document.createElement('aside'); filesPane.className = 'dev-files-pane'; filesPane.innerHTML = '<div class="dev-pane-title">ПРОЕКТ</div>';
  const fileSearch = document.createElement('input'); fileSearch.className = 'dev-tree-search'; fileSearch.type = 'search'; fileSearch.placeholder = '⌕  Быстрый поиск файлов'; fileSearch.setAttribute('aria-label', 'Поиск файлов проекта');
  const fileList = document.createElement('div'); fileList.className = 'dev-file-list dev-file-tree'; filesPane.append(fileList);
  filesPane.insertBefore(fileSearch, fileList);
  const ai = document.createElement('aside'); ai.className = 'dev-ai-pane';
  const output = document.createElement('pre'); output.className = 'dev-output'; output.textContent = 'Журнал сборки появится здесь.';
  const aiTitle = document.createElement('div'); aiTitle.className = 'dev-pane-title'; aiTitle.textContent = '✦ AI ПОМОЩНИК';
  const provider = document.createElement('select'); provider.className = 'settings-select';
  provider.add(new Option('OpenAI · ChatGPT', 'openai')); provider.add(new Option('Google · Gemini', 'gemini')); provider.add(new Option('Anthropic · Claude', 'anthropic'));
  const model = document.createElement('input'); model.className = 'version-search'; model.value = 'gpt-4.1-mini'; model.placeholder = 'Название модели API';
  const modelList = document.createElement('datalist'); modelList.id = 'dev-ai-model-options'; model.setAttribute('list', modelList.id);
  const key = document.createElement('input'); key.className = 'version-search'; key.type = 'password'; key.autocomplete = 'new-password'; key.placeholder = 'API-ключ';
  const keyStatus = document.createElement('div'); keyStatus.className = 'dev-ai-status';
  const keyActions = document.createElement('div'); keyActions.className = 'dev-ai-key-actions';
  const saveKey = devButton('Сохранить ключ', 'dev-secondary');
  const clearKey = devButton('Удалить ключ', 'dev-secondary');
  const refreshModels = devButton('Проверить API · модели ↻', 'dev-secondary');
  keyActions.append(saveKey, clearKey);
  const chatHead = document.createElement('div'); chatHead.className = 'dev-chat-head';
  const chatLabel = document.createElement('span'); chatLabel.textContent = 'ЧАТ ПО ПРОЕКТУ';
  const clearChat = devButton('Очистить', 'dev-chat-clear'); chatHead.append(chatLabel, clearChat);
  const chatMessages = document.createElement('div'); chatMessages.className = 'dev-chat-messages';
  const prompt = document.createElement('textarea'); prompt.className = 'dev-ai-prompt'; prompt.placeholder = 'Например: добавь предмет «Кристалл» и объясни, какие файлы изменить…';
  const askAi = devButton('Отправить ↗', 'dev-run');
  ai.append(aiTitle, provider, model, modelList, key, keyActions, keyStatus, refreshModels, chatHead, chatMessages, prompt, askAi);
  editorPane.append(tabs, findBar, editor, status, output);
  layout.append(filesPane, editorPane, ai); wrap.append(toolbar, locationBar, layout);
  openModal('NOVA Studio', wrap);
  let activeFile = '';
  let savedContents = '';
  let saveTimer = null;
  let saveInFlight = null;
  let aiHistory = [];
  let busy = false;
  devBusyReset = () => { busy = false; };
  let projectEntries = [];
  let findPositions = [];
  const updateFindCount = () => {
    const term = findInput.value.toLocaleLowerCase();
    const source = editor.value.toLocaleLowerCase();
    findPositions = [];
    if (term) for (let position = source.indexOf(term); position !== -1; position = source.indexOf(term, position + term.length)) findPositions.push(position);
    const current = findPositions.findIndex(position => editor.selectionStart >= position && editor.selectionStart <= position + term.length);
    findCount.textContent = findPositions.length ? `${current < 0 ? '0' : current + 1} / ${findPositions.length}` : '0 / 0';
  };
  const selectFindMatch = direction => {
    updateFindCount();
    if (!findPositions.length) return;
    let index = direction > 0 ? findPositions.findIndex(position => position >= editor.selectionEnd) : findPositions.findLastIndex(position => position < editor.selectionStart);
    if (index < 0) index = direction > 0 ? 0 : findPositions.length - 1;
    const position = findPositions[index];
    editor.focus(); editor.setSelectionRange(position, position + findInput.value.length); updateFindCount();
  };
  previousMatch.addEventListener('click', () => selectFindMatch(-1));
  nextMatch.addEventListener('click', () => selectFindMatch(1));
  findInput.addEventListener('input', () => selectFindMatch(1));
  findInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); selectFindMatch(event.shiftKey ? -1 : 1); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); findBar.hidden = true; editor.focus(); }
  });
  toggleReplace.addEventListener('click', () => { replaceRow.hidden = !replaceRow.hidden; if (!replaceRow.hidden) replaceInput.focus(); });
  closeFind.addEventListener('click', () => { findBar.hidden = true; editor.focus(); });
  const replaceCurrent = () => {
    const term = findInput.value;
    if (!term) { findInput.focus(); return; }
    const start = editor.selectionStart; const end = editor.selectionEnd;
    if (editor.value.slice(start, end).toLocaleLowerCase() !== term.toLocaleLowerCase()) { selectFindMatch(1); return; }
    editor.setRangeText(replaceInput.value, start, end, 'end'); editor.dispatchEvent(new Event('input', { bubbles: true })); selectFindMatch(1);
  };
  replaceOne.addEventListener('click', replaceCurrent);
  replaceInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); replaceCurrent(); } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); findBar.hidden = true; editor.focus(); } });
  replaceAll.addEventListener('click', () => {
    const term = findInput.value;
    if (!term) { findInput.focus(); return; }
    const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = editor.value.match(new RegExp(safeTerm, 'gi')) || [];
    if (!matches.length) { toast('Совпадений не найдено.'); return; }
    editor.value = editor.value.replace(new RegExp(safeTerm, 'gi'), replaceInput.value);
    editor.dispatchEvent(new Event('input', { bubbles: true })); updateFindCount(); toast(`Заменено совпадений: ${matches.length}.`);
  });
  const showFile = async file => {
    if (activeFile && editor.value !== savedContents && !(await saveFile({ silent: true }))) return;
    activeFile = file;
    try {
      editor.value = await window.nova.devRead({ projectId: project.id, file });
      savedContents = editor.value;
      updateFindCount();
      status.textContent = `${file} · UTF-8`; tabs.textContent = file.split('/').pop(); tabs.title = file;
      fileList.querySelectorAll('.dev-file-button').forEach(button => button.classList.toggle('selected', button.dataset.path === file));
    } catch (error) { toast(error.message || 'Не удалось прочитать файл.'); }
  };
  const refreshProjectTree = async openFile => {
    projectEntries = await window.nova.devFiles({ projectId: project.id });
    fileList.replaceChildren();
    const root = { children: new Map() };
    for (const entry of projectEntries) {
      const parts = entry.path.split('/'); let parent = root;
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index];
        if (!parent.children.has(part)) parent.children.set(part, { name: part, path: parts.slice(0, index + 1).join('/'), children: new Map(), type: index === parts.length - 1 ? entry.type : 'directory' });
        parent = parent.children.get(part);
      }
      parent.type = entry.type; parent.editable = entry.editable;
    }
    const draw = (container, nodes, depth = 0) => {
      const sorted = [...nodes.values()].sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) : a.type === 'directory' ? -1 : 1);
      for (const node of sorted) {
        if (node.type === 'directory') {
          const branch = document.createElement('div'); branch.className = 'dev-tree-branch';
          const button = document.createElement('button'); button.className = 'dev-tree-folder'; button.style.paddingLeft = `${6 + depth * 12}px`;
          button.dataset.path = node.path;
          const arrow = document.createElement('span'); arrow.className = 'dev-tree-arrow'; arrow.textContent = '⌄';
          const icon = document.createElement('span'); icon.className = 'dev-tree-folder-icon'; icon.textContent = '▰';
          const label = document.createElement('span'); label.textContent = node.name; label.title = node.path;
          button.append(arrow, icon, label);
          const children = document.createElement('div'); children.className = 'dev-tree-children';
          if (['build', 'run'].includes(node.name)) { children.hidden = true; arrow.textContent = '›'; }
          button.addEventListener('click', () => { children.hidden = !children.hidden; arrow.textContent = children.hidden ? '›' : '⌄'; });
          branch.append(button, children); container.append(branch); draw(children, node.children, depth + 1);
        } else {
          const button = document.createElement('button'); button.className = 'dev-file-button'; button.style.paddingLeft = `${15 + depth * 12}px`;
          const icon = node.name.endsWith('.java') ? '◉' : node.name.endsWith('.json') || node.name.endsWith('.mcmeta') ? '{}' : node.name.endsWith('.png') ? '▧' : '▤';
          button.textContent = `${icon}  ${node.name}`; button.dataset.path = node.path; button.title = node.editable ? node.path : `${node.path} · бинарный файл`;
          if (node.editable) button.addEventListener('click', () => showFile(node.path));
          else { button.classList.add('dev-binary-file'); button.addEventListener('click', async () => { try { await window.nova.devRevealEntry({ projectId: project.id, entryPath: node.path }); toast(`Показал ${node.name} в Проводнике.`); } catch (error) { toast(error.message || 'Не удалось показать файл.'); } }); }
          container.append(button);
        }
      }
    };
    draw(fileList, root.children);
    const filterTree = (container, query, revealAll = false) => {
      let anyVisible = false;
      for (const child of container.children) {
        if (child.classList.contains('dev-tree-branch')) {
          const folder = child.querySelector(':scope > .dev-tree-folder');
          const children = child.querySelector(':scope > .dev-tree-children');
          const matches = !query || folder.dataset.path.toLocaleLowerCase().includes(query);
          const descendantVisible = filterTree(children, query, revealAll || matches);
          if (query && (matches || descendantVisible)) { children.hidden = false; folder.querySelector('.dev-tree-arrow').textContent = '⌄'; }
          child.hidden = !(revealAll || matches || descendantVisible);
          anyVisible ||= !child.hidden;
        } else if (child.classList.contains('dev-file-button')) {
          child.hidden = !(revealAll || !query || child.dataset.path.toLocaleLowerCase().includes(query));
          anyVisible ||= !child.hidden;
        }
      }
      return anyVisible;
    };
    fileSearch.addEventListener('input', () => filterTree(fileList, fileSearch.value.trim().toLocaleLowerCase()));
    const firstJava = projectEntries.find(entry => entry.type === 'file' && entry.editable && entry.path.endsWith('.java'))?.path;
    const nextFile = openFile && projectEntries.some(entry => entry.type === 'file' && entry.editable && entry.path === openFile) ? openFile : activeFile && projectEntries.some(entry => entry.type === 'file' && entry.editable && entry.path === activeFile) ? activeFile : firstJava || projectEntries.find(entry => entry.type === 'file' && entry.editable)?.path;
    if (nextFile) await showFile(nextFile);
    else { editor.value = ''; editor.placeholder = 'В этом проекте пока нет редактируемых текстовых файлов. Создай новый файл кнопкой «＋ Файл».'; status.textContent = 'Файлов для редактирования пока нет.'; tabs.textContent = 'Нет открытого файла'; }
  };
  const createProjectEntry = type => {
    const form = document.createElement('div'); form.className = 'dev-new-project';
    const heading = document.createElement('h3'); heading.textContent = type === 'file' ? 'Новый файл' : 'Новая папка';
    const input = document.createElement('input'); input.className = 'version-search';
    const parentPath = activeFile ? activeFile.split('/').slice(0, -1).join('/') : 'src/main/java';
    input.value = `${parentPath ? `${parentPath}/` : ''}${type === 'file' ? 'NewFile.java' : 'new-folder'}`;
    const help = document.createElement('p'); help.className = 'settings-help'; help.textContent = `Укажи путь относительно папки проекта: ${project.id}/…`;
    const create = devButton(type === 'file' ? 'Создать файл' : 'Создать папку', 'dev-run');
    form.append(heading, fieldLabel('ПУТЬ В ПРОЕКТЕ', input), help, create); openModal(heading.textContent, form);
    create.addEventListener('click', async () => {
      create.disabled = true;
      try { const entry = await window.nova.devCreateEntry({ projectId: project.id, entryPath: input.value.trim(), type }); closeModal(); await refreshProjectTree(type === 'file' ? entry.path : undefined); toast(type === 'file' ? 'Файл создан.' : 'Папка создана.'); }
      catch (error) { create.disabled = false; toast(error.message || 'Не удалось создать файл.'); }
    });
  };
  await refreshProjectTree();
  devSaveOnClose = () => saveFile({ silent: true });
  const scheduleAutoSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveFile({ silent: true }); }, 700);
  };
  editor.addEventListener('input', () => {
    updateFindCount();
    if (!activeFile || editor.value === savedContents) return;
    status.classList.add('unsaved');
    status.textContent = `● Не сохранено · ${activeFile}`;
    scheduleAutoSave();
  });
  editor.addEventListener('keydown', event => {
    if (event.key === 'Tab') { event.preventDefault(); const start = editor.selectionStart; editor.setRangeText('    ', start, editor.selectionEnd, 'end'); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveFile(); }
  });
  async function saveFile({ silent = false } = {}) {
    if (!activeFile) return true;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (saveInFlight) { try { await saveInFlight; } catch {} if (editor.value === savedContents) return true; }
    if (editor.value === savedContents) { status.classList.remove('unsaved'); status.textContent = `Сохранено · ${activeFile}`; return true; }
    const file = activeFile; const contents = editor.value;
    const operation = (async () => {
      await window.nova.devWrite({ projectId: project.id, file, contents });
      if (activeFile === file) {
        savedContents = contents;
        if (editor.value === contents) { status.classList.remove('unsaved'); status.textContent = `✓ Сохранено · ${file}`; }
        else { status.classList.add('unsaved'); status.textContent = `● Не сохранено · ${file}`; scheduleAutoSave(); }
      }
    })();
    saveInFlight = operation;
    try { await operation; if (!silent) toast('Файл сохранён.'); return editor.value === contents; }
    catch (error) { toast(error.message || 'Не удалось сохранить файл.'); return false; }
    finally { if (saveInFlight === operation) saveInFlight = null; }
  }
  async function runTask(action) {
    if (busy) return; busy = true; output.textContent = 'Сохраняем файл и запускаем Gradle…\n';
    try { await saveFile(); await window.nova[action]({ projectId: project.id }); status.textContent = action === 'devRun' ? 'Запуск тестового клиента Minecraft…' : 'Сборка мода…'; }
    catch (error) { busy = false; output.textContent += `${error.message || error}\n`; toast(error.message || 'Не удалось запустить Gradle.'); }
  }
  save.addEventListener('click', saveFile);
  back.addEventListener('click', async () => { if (await saveFile({ silent: true })) { devSaveOnClose = null; openDevMode(); } });
  removeProject.addEventListener('click', async () => { if (await saveFile({ silent: true })) confirmDeleteProject(project, openDevMode); });
  newFile.addEventListener('click', async () => { if (await saveFile({ silent: true })) createProjectEntry('file'); });
  newFolder.addEventListener('click', async () => { if (await saveFile({ silent: true })) createProjectEntry('directory'); });
  openFolder.addEventListener('click', async () => { try { await window.nova.devOpen({ projectId: project.id }); } catch (error) { toast(error.message || 'Не удалось открыть папку.'); } });
  build.addEventListener('click', () => runTask('devBuild')); run.addEventListener('click', () => runTask('devRun'));
  installMod.addEventListener('click', async () => { try { const result = await window.nova.devInstall({ projectId: project.id }); toast(`${result.filename} добавлен в профиль Fabric ${result.mcVersion}.`); } catch (error) { toast(error.message || 'Не удалось установить JAR в профиль.'); } });
  stop.addEventListener('click', async () => { await window.nova.devStop(); busy = false; });
  const defaults = { openai: 'gpt-4.1-mini', gemini: 'gemini-3.8-flash', anthropic: 'claude-sonnet-4-6' };
  const refreshKeyStatus = async () => { const keys = await window.nova.devAiStatus(); keyStatus.textContent = keys[provider.value] ? '✓ Ключ защищённо сохранён в Windows.' : 'Сначала добавь API-ключ своего аккаунта.'; };
  const loadProviderModels = async (quiet = false) => {
    refreshModels.disabled = true; refreshModels.textContent = 'Проверяем подключение…';
    try {
      const result = await window.nova.devModels({ provider: provider.value });
      modelList.replaceChildren(...result.models.map(id => { const option = document.createElement('option'); option.value = id; return option; }));
      if (result.models.length && !result.models.includes(model.value)) model.value = result.models[0];
      keyStatus.textContent = `✓ API подключён · доступно моделей: ${result.models.length}.`;
      if (!quiet) toast(`Подключение работает: найдено моделей ${result.models.length}.`);
    } catch (error) { keyStatus.textContent = error.message || 'Не удалось проверить API.'; if (!quiet) toast(error.message || 'Проверь API-ключ и подключение.'); }
    finally { refreshModels.disabled = false; refreshModels.textContent = 'Проверить API · модели ↻'; }
  };
  provider.addEventListener('change', async () => { model.value = defaults[provider.value]; modelList.replaceChildren(); await refreshKeyStatus(); });
  await refreshKeyStatus();
  saveKey.addEventListener('click', async () => { if (!key.value.trim()) { toast('Введи API-ключ выбранного провайдера.'); return; } try { await window.nova.devAiSave({ [provider.value]: key.value.trim() }); key.value = ''; await loadProviderModels(true); } catch (error) { toast(error.message || 'Не удалось сохранить ключ.'); } });
  clearKey.addEventListener('click', async () => { try { await window.nova.devAiClear(provider.value); await refreshKeyStatus(); modelList.replaceChildren(); toast('API-ключ выбранного провайдера удалён.'); } catch (error) { toast(error.message || 'Не удалось удалить ключ.'); } });
  refreshModels.addEventListener('click', () => loadProviderModels());
  const renderChat = () => {
    chatMessages.replaceChildren();
    if (!aiHistory.length) { const hint = document.createElement('div'); hint.className = 'dev-chat-empty'; hint.textContent = 'Спроси про код, ошибку сборки или идею для мода. AI увидит открытый файл.'; chatMessages.append(hint); return; }
    for (const item of aiHistory) { const bubble = document.createElement('div'); bubble.className = `dev-chat-bubble ${item.role}`; bubble.textContent = item.content; chatMessages.append(bubble); }
    chatMessages.scrollTop = chatMessages.scrollHeight;
  };
  const sendAi = async () => {
    const userText = prompt.value.trim();
    if (!userText) { toast('Напиши сообщение для помощника.'); prompt.focus(); return; }
    if (!model.value.trim()) { toast('Выбери модель или проверь API.'); return; }
    askAi.disabled = true; askAi.textContent = 'AI отвечает…';
    const pending = document.createElement('div'); pending.className = 'dev-chat-bubble assistant pending'; pending.textContent = 'Думаю…'; chatMessages.append(pending); chatMessages.scrollTop = chatMessages.scrollHeight;
    try {
      const answer = await window.nova.devAi({ provider: provider.value, model: model.value.trim(), history: aiHistory, prompt: userText, projectId: project.id, file: activeFile, contents: editor.value });
      aiHistory.push({ role: 'user', content: userText }, { role: 'assistant', content: answer });
      if (aiHistory.length > 24) aiHistory = aiHistory.slice(-24);
      prompt.value = ''; renderChat();
    } catch (error) {
      pending.classList.remove('pending'); pending.classList.add('error');
      const message = error.message || 'Не удалось связаться с AI-провайдером.';
      if (provider.value === 'openai' && /no credits remaining|insufficient_quota|quota|billing|exceeded.*limit/i.test(message)) {
        pending.textContent = 'У OpenAI API закончился баланс или исчерпан лимит. Пополни баланс и проверь ограничения расходов. Подписка ChatGPT не включает оплату API.';
        const billing = devButton('Открыть оплату OpenAI ↗', 'dev-ai-billing-link');
        billing.addEventListener('click', () => window.nova.openOpenAiBilling().catch(() => toast('Не удалось открыть страницу оплаты OpenAI.')));
        pending.append(document.createElement('br'), billing);
      } else pending.textContent = message;
    } finally { askAi.disabled = false; askAi.textContent = 'Отправить ↗'; }
  };
  askAi.addEventListener('click', sendAi);
  prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendAi(); } });
  clearChat.addEventListener('click', () => { aiHistory = []; renderChat(); });
  renderChat();
}

function devButton(text, className) { const button = document.createElement('button'); button.className = className; button.textContent = text; return button; }

async function updateJavaStatus() {
  try {
    const result = await window.nova.java();
    $('java-message').textContent = result.available
      ? `Найдена Java ${result.version}. Перед запуском проверим, подходит ли она версии игры.`
      : 'Java не найдена. Установи Java, чтобы запускать Minecraft.';
    $('java-message').style.color = result.available ? '#a5a6ae' : '#f1ad83';
  } catch {
    $('java-message').textContent = 'Не удалось проверить Java. Её наличие проверится при запуске.';
  }
}

async function loadVersions() {
  $('launch-status').textContent = 'Загружаем каталог версий…';
  $('refresh-versions').disabled = true;
  try {
    const result = await window.nova.versions();
    versions = result.versions;
    select.replaceChildren();
    for (const version of versions) select.add(new Option(version.id, version.id));
    const remembered = localStorage.getItem('nova-version');
    select.value = versions.some(item => item.id === remembered) ? remembered : result.latest.release;
    syncVersion();
    $('version-count').textContent = String(versions.length);
    $('launch-status').textContent = 'Каталог версий загружен';
    await loadLoaderVersions();
  } catch (error) {
    select.replaceChildren();
    $('version-count').textContent = '—';
    $('launch-status').textContent = 'Не удалось загрузить каталог';
    toast(error.message || 'Не удалось загрузить версии. Проверь подключение к интернету.');
  } finally {
    $('refresh-versions').disabled = false;
  }
}

function openSettings() {
  const wrap = document.createElement('div');
  const memoryLabel = document.createElement('label');
  memoryLabel.className = 'setting-label';
  memoryLabel.textContent = 'ОПЕРАТИВНАЯ ПАМЯТЬ ДЛЯ ИГРЫ';
  const memory = document.createElement('select');
  memory.className = 'settings-select';
  for (const amount of [2, 3, 4, 6, 8, 10, 12, 16]) memory.add(new Option(`${amount} ГБ`, String(amount)));
  memory.value = localStorage.getItem('nova-memory') || '4';
  memory.addEventListener('change', () => localStorage.setItem('nova-memory', memory.value));
  const help = document.createElement('p');
  help.className = 'settings-help';
  help.textContent = 'Выбери объём, который выделяется Minecraft. Оставь память для Windows и других программ.';
  const folderTitle = document.createElement('div');
  folderTitle.className = 'setting-label folder-setting-title';
  folderTitle.textContent = 'ПАПКА ИГРЫ';
  const folderInfo = document.createElement('p');
  folderInfo.className = 'settings-help';
  folderInfo.textContent = 'Здесь хранятся установленные версии, игровые библиотеки и ресурсы.';
  const openFolder = document.createElement('button');
  openFolder.className = 'settings-folder-button';
  openFolder.textContent = 'Открыть папку Minecraft  ↗';
  openFolder.addEventListener('click', async () => {
    try { await window.nova.openFolder(); } catch (error) { toast(error.message || 'Не удалось открыть папку игры.'); }
  });
  const java = document.createElement('div');
  java.className = 'settings-java';
  java.textContent = $('java-message').textContent;
  const diagnostics = document.createElement('section'); diagnostics.className = 'launcher-diagnostics';
  const diagnosticsHead = document.createElement('div'); diagnosticsHead.className = 'setting-label folder-setting-title'; diagnosticsHead.textContent = 'ПРОВЕРКА ГОТОВНОСТИ';
  const diagnosticsHelp = document.createElement('p'); diagnosticsHelp.className = 'settings-help'; diagnosticsHelp.textContent = 'Проверь Java, память и подключение к игровым сервисам перед запуском.';
  const diagnosticsButton = document.createElement('button'); diagnosticsButton.className = 'settings-folder-button'; diagnosticsButton.textContent = 'Проверить готовность ↻';
  const diagnosticsReport = document.createElement('div'); diagnosticsReport.className = 'diagnostics-report'; diagnosticsReport.textContent = 'Проверка займёт несколько секунд.';
  diagnosticsButton.addEventListener('click', async () => {
    diagnosticsButton.disabled = true; diagnosticsButton.textContent = 'Проверяем…'; diagnosticsReport.replaceChildren();
    try {
      const result = await window.nova.diagnostics({ version: select.value, memory: memory.value });
      const javaCompatible = result.java.available && (!result.requiredJava || result.java.major >= result.requiredJava);
      const memoryOkay = result.memory.requestedGb <= result.memory.freeGb;
      const rows = [
        { ok: javaCompatible, title: 'Java', detail: !result.java.available ? 'Не найдена — установи подходящую Java.' : result.requiredJava && result.java.major < result.requiredJava ? `Java ${result.java.major}, игре нужна Java ${result.requiredJava}.` : `Java ${result.java.version}${result.requiredJava ? ` · подходит для ${select.value}` : ''}.` },
        { ok: memoryOkay, title: 'Память', detail: `Выделено ${result.memory.requestedGb} ГБ · свободно ${result.memory.freeGb} из ${result.memory.totalGb} ГБ.` },
        ...result.services.map(service => ({ ok: service.ok, title: service.name, detail: service.detail }))
      ];
      for (const item of rows) {
        const row = document.createElement('div'); row.className = `diagnostic-row ${item.ok ? 'ok' : 'warn'}`;
        const icon = document.createElement('span'); icon.textContent = item.ok ? '✓' : '!';
        const copy = document.createElement('span'); copy.className = 'diagnostic-copy';
        const title = document.createElement('strong'); title.textContent = item.title;
        const detail = document.createElement('small'); detail.textContent = item.detail;
        copy.append(title, detail); row.append(icon, copy); diagnosticsReport.append(row);
      }
      toast(rows.every(item => item.ok) ? 'Всё готово к запуску.' : 'Проверка завершена: посмотри пункты с предупреждением.');
    } catch (error) { diagnosticsReport.textContent = error.message || 'Не удалось выполнить проверку.'; }
    finally { diagnosticsButton.disabled = false; diagnosticsButton.textContent = 'Проверить ещё раз ↻'; }
  });
  diagnostics.append(diagnosticsHead, diagnosticsHelp, diagnosticsButton, diagnosticsReport);
  const discordHeading = document.createElement('div');
  discordHeading.className = 'setting-label folder-setting-title';
  discordHeading.textContent = 'DISCORD RICH PRESENCE';
  const discordHelp = document.createElement('p');
  discordHelp.className = 'settings-help';
  discordHelp.textContent = 'Интеграция NOVA включена автоматически. Application ID зафиксирован в лаунчере и недоступен для изменения.';
  const discordStatus = document.createElement('div');
  discordStatus.className = 'discord-status';
  discordStatus.textContent = 'Проверяем Discord…';
  window.nova.discordStatus().then(status => { discordStatus.textContent = status; }).catch(() => { discordStatus.textContent = 'Не удалось проверить соединение с Discord.'; });
  const versionTogglesTitle = document.createElement('div');
  versionTogglesTitle.className = 'setting-label folder-setting-title';
  versionTogglesTitle.textContent = 'КАТАЛОГ ВЕРСИЙ';
  const versionToggles = document.createElement('div');
  versionToggles.className = 'settings-version-toggles';
  for (const [key, label] of [['nova-show-snapshots', 'Показывать снапшоты'], ['nova-show-old-versions', 'Показывать альфа- и бета-версии']]) {
    const toggle = document.createElement('label');
    toggle.className = 'version-toggle-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = localStorage.getItem(key) === 'true';
    checkbox.addEventListener('change', () => localStorage.setItem(key, String(checkbox.checked)));
    const text = document.createElement('span');
    text.textContent = label;
    toggle.append(checkbox, text);
    versionToggles.append(toggle);
  }
  wrap.append(memoryLabel, memory, help, java, diagnostics, discordHeading, discordHelp, discordStatus, versionTogglesTitle, versionToggles, folderTitle, folderInfo, openFolder);
  openModal('Настройки лаунчера', wrap);
}

select.addEventListener('change', syncVersion);
select.addEventListener('change', () => { localStorage.setItem('nova-version', select.value); loadLoaderVersions(); });
$('loader-select').value = localStorage.getItem('nova-loader') || 'vanilla';
$('loader-select').addEventListener('change', () => { localStorage.setItem('nova-loader', $('loader-select').value); loadLoaderVersions(); });
$('version-toggle').addEventListener('click', openVersions);
$('refresh-versions').addEventListener('click', openVersions);
$('mod-browser-button').addEventListener('click', openMods);
const launchLogButton = document.querySelector('.dots-button');
launchLogButton.textContent = 'Журнал ↗'; launchLogButton.setAttribute('aria-label', 'Журнал запуска'); launchLogButton.title = 'Открыть журнал запуска';
launchLogButton.addEventListener('click', openLaunchLog);
$('save-profile').addEventListener('click', () => setName(username.value));
$('creator-channel').addEventListener('click', event => {
  event.preventDefault();
  window.nova.openCreatorChannel().catch(error => toast(error.message || 'Не удалось открыть канал YouTube.'));
});
username.addEventListener('keydown', event => { if (event.key === 'Enter') setName(username.value); });
$('modal-close').addEventListener('click', closeModal);
let modalPointerStartedOutside = false;
modalBackdrop.addEventListener('pointerdown', event => { modalPointerStartedOutside = event.target === modalBackdrop; });
modalBackdrop.addEventListener('pointerup', event => {
  const shouldClose = modalPointerStartedOutside && event.target === modalBackdrop;
  modalPointerStartedOutside = false;
  if (shouldClose) closeModal();
});
modalBackdrop.addEventListener('pointercancel', () => { modalPointerStartedOutside = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modalBackdrop.hidden) closeModal(); });
document.addEventListener('keydown', event => {
  if (modalBackdrop.hidden || $('modal-title').textContent !== 'NOVA Studio' || !(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === 'p') {
    event.preventDefault();
    modalBody.querySelector('.dev-tree-search')?.focus();
  } else if (event.key.toLowerCase() === 's') {
    event.preventDefault();
    modalBody.querySelector('.dev-save-action')?.click();
  } else if (['f', 'h'].includes(event.key.toLowerCase())) {
    event.preventDefault();
    const bar = modalBody.querySelector('.dev-findbar');
    const search = bar?.querySelector('.dev-find-input');
    const replacement = bar?.querySelector('.dev-replace-row');
    const editor = modalBody.querySelector('.code-editor');
    if (!bar || !search || !editor) return;
    bar.hidden = false;
    if (event.key.toLowerCase() === 'h') replacement.hidden = false;
    const selectedText = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    if (selectedText && !search.value) search.value = selectedText;
    search.focus(); search.select(); search.dispatchEvent(new Event('input', { bubbles: true }));
  }
});
document.addEventListener('keydown', event => {
  if (!modalBackdrop.hidden || !(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return;
  event.preventDefault();
  play();
});
document.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', event => {
  event.preventDefault();
  document.querySelectorAll('.nav-item').forEach(link => link.classList.toggle('active', link === item));
  const action = item.dataset.action;
  if (action === 'versions') openVersions();
  else if (action === 'mods') openMods();
  else if (action === 'development') openDevMode();
  else if (action === 'settings') openSettings();
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}));

const saved = localStorage.getItem('nova-username') || 'Steve';
setName(saved, true);

async function play() {
  if (gameRunning) {
    $('play-button').disabled = true;
    $('play-label').textContent = 'ЗАКРЫВАЕМ…';
    try { await window.nova.stop(); }
    catch (error) { $('play-button').disabled = false; $('play-label').textContent = 'ВЫЙТИ ИЗ ИГРЫ'; toast(error.message || 'Не получилось закрыть Minecraft.'); }
    return;
  }
  const name = username.value.trim();
  if (!setName(name, true)) { toast('Сначала укажи игровой ник из 3–16 символов.'); return; }
  if (!select.value) { toast('Каталог версий ещё не загружен.'); return; }
  addLauncherLog('launcher', `Запуск Minecraft ${select.value} · ${$('loader-select').value} · ${name}`);
  $('play-button').disabled = true;
  $('hero-play').disabled = true;
  $('play-label').textContent = 'ПОДГОТОВКА…';
  $('progress-wrap').classList.add('visible');
  $('progress-label').textContent = `Проверяем файлы Minecraft ${select.value}…`;
  $('progress-percent').textContent = 'Проверка';
  $('progress-bar').style.width = '2%';
  $('launch-status').textContent = 'Проверяем наличие игровых файлов…';
  try {
    await window.nova.play({
      name,
      version: select.value,
      memory: Number(localStorage.getItem('nova-memory') || 4),
      loader: $('loader-select').value,
      loaderVersion: $('loader-version-select').value || undefined,
      forgeVersion: $('loader-select').value === 'forge' ? $('loader-version-select').value : undefined
    });
    gameRunning = true;
    $('play-button').disabled = false;
    $('play-label').textContent = 'ВЫЙТИ ИЗ ИГРЫ';
    $('play-button').classList.add('exit-game');
    $('progress-percent').textContent = '100%';
    $('progress-bar').style.width = '100%';
  } catch (error) {
    $('play-button').disabled = false;
    $('hero-play').disabled = false;
    $('play-label').textContent = 'ИГРАТЬ';
    $('play-button').classList.remove('exit-game');
    $('progress-label').textContent = 'Не удалось подготовить игру';
    $('progress-percent').textContent = '';
    $('progress-bar').style.width = '0';
    $('launch-status').textContent = 'Нужна помощь для запуска';
    toast(error.message || 'Ошибка запуска. Проверь Java и подключение к интернету.');
  }
}

$('play-button').addEventListener('click', play);
$('hero-play').addEventListener('click', play);
$('exit-button').addEventListener('click', async () => {
  try { await window.nova.quit(); }
  catch (error) { toast(error.message || 'Не получилось закрыть лаунчер.'); }
});
window.nova.onEvent(({ kind, data }) => {
  addLauncherLog(kind, data);
  if (kind === 'discord-status') {
    document.querySelectorAll('.discord-status').forEach(status => { status.textContent = data; });
  }
  if (kind === 'status') $('launch-status').textContent = data;
  if (kind === 'stage') {
    try {
      const stage = typeof data === 'string' ? JSON.parse(data) : data;
      $('progress-label').textContent = stage.label;
      $('progress-percent').textContent = `${stage.percent}%`;
      $('progress-bar').style.width = `${stage.percent}%`;
      $('launch-status').textContent = stage.label;
      if (stage.percent === 100) {
        gameRunning = true;
        $('play-button').disabled = false;
        $('play-label').textContent = 'ВЫЙТИ ИЗ ИГРЫ';
        $('play-button').classList.add('exit-game');
      } else $('play-label').textContent = 'СКАЧИВАНИЕ…';
    } catch {}
  }
  if (kind === 'progress' && data) {
    try {
      const progress = typeof data === 'string' ? JSON.parse(data) : data;
      const total = Number(progress.total) || 0;
      const current = Number(progress.task) || 0;
      if (total) {
        const part = Math.min(1, current / total);
        const percent = Math.min(94, Math.max(5, Math.round(5 + part * 88)));
        $('progress-label').textContent = `Проверяем ресурсы Minecraft (${current.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')})`;
        $('progress-percent').textContent = `${percent}%`;
        $('progress-bar').style.width = `${percent}%`;
        $('play-label').textContent = 'СКАЧИВАНИЕ…';
      }
    } catch {}
  }
  if (kind === 'download' && data) {
    try {
      const file = typeof data === 'string' ? JSON.parse(data) : data;
      const total = Number(file.total) || 0;
      const current = Number(file.current) || 0;
      const size = bytes => bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.round(bytes / 1024)} КБ`;
      if (total) {
        const percent = Math.min(94, Math.max(5, Math.round(5 + current / total * 88)));
        $('progress-label').textContent = `Скачиваем ${file.name || 'файл'} · ${size(current)} / ${size(total)}`;
        $('progress-percent').textContent = `${percent}%`;
        $('progress-bar').style.width = `${percent}%`;
        $('play-label').textContent = 'СКАЧИВАНИЕ…';
      }
    } catch {}
  }
  if (kind === 'mod-progress' && data) {
    try {
      const progress = typeof data === 'string' ? JSON.parse(data) : data;
      const status = $('mod-install-progress');
      if (status) status.textContent = `Установлено ${progress.current} файл(ов): ${progress.name}`;
    } catch {}
  }
  if (kind === 'fabric-install-progress' && data) {
    try { const progress = typeof data === 'string' ? JSON.parse(data) : data; $('launch-status').textContent = `Fabric API: ${progress.current}/${progress.total} · ${progress.name}`; } catch {}
  }
  if (kind === 'dev-output' && data) {
    try {
      const result = typeof data === 'string' ? JSON.parse(data) : data;
      const box = document.querySelector('.dev-output');
      if (box) { box.textContent += result.text; box.scrollTop = box.scrollHeight; }
      if (result.kind === 'exit') {
        devBusyReset?.();
        const status = document.querySelector('.dev-status');
        if (status) status.textContent = result.text;
        const run = document.querySelector('.dev-run');
        if (run) run.disabled = false;
      }
    } catch {}
  }
  if (kind === 'close') {
    gameRunning = false;
    $('play-button').disabled = false;
    $('hero-play').disabled = false;
    $('play-label').textContent = 'ИГРАТЬ';
    $('play-button').classList.remove('exit-game');
    $('progress-wrap').classList.remove('visible');
    $('launch-status').textContent = 'Minecraft закрыт';
  }
  if (kind === 'launch-failed') {
    const message = typeof data === 'string' ? data : String(data);
    $('play-button').disabled = false;
    $('hero-play').disabled = false;
    $('play-label').textContent = 'ИГРАТЬ';
    $('progress-label').textContent = 'Не удалось подготовить игру';
    $('launch-status').textContent = 'Запуск не выполнен';
    toast(message);
  }
  if (kind === 'error' || kind === 'warning') console.warn('[NOVA]', data);
  if (kind === 'log') console.log('[NOVA]', data);
});

loadVersions();
updateJavaStatus();
