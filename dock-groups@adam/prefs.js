import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const GROUP_PREFIX = 'dock-group-';
const desktopIdFor = id => `${GROUP_PREFIX}${id}.desktop`;

function parseJson(str, fallback) {
    try {
        return JSON.parse(str) ?? fallback;
    } catch {
        return fallback;
    }
}

function newId() {
    return GLib.uuid_string_random().replace(/-/g, '').slice(0, 10);
}

function appCountLabel(n) {
    if (n === 1)
        return '1 aplikácia';
    if (n >= 2 && n <= 4)
        return `${n} aplikácie`;
    return `${n} aplikácií`;
}

function lookupApp(id) {
    try {
        return GioUnix.DesktopAppInfo.new(id);
    } catch {
        return null;
    }
}

function groupIcon(groupId) {
    const path = GLib.build_filenamev([GLib.get_user_data_dir(), 'applications', desktopIdFor(groupId)]);
    try {
        const info = GioUnix.DesktopAppInfo.new_from_filename(path);
        if (info?.get_icon())
            return Gtk.Image.new_from_gicon(info.get_icon());
    } catch {}
    return Gtk.Image.new_from_icon_name('folder-symbolic');
}

function allApps() {
    return Gio.AppInfo.get_all()
        .filter(a => a.should_show() && a.get_id() && !a.get_id().startsWith(GROUP_PREFIX))
        .sort((a, b) => a.get_name().localeCompare(b.get_name()));
}

export default class DockGroupsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
        this._window = window;
        this._expanded = new Set();
        this._rows = [];

        window.set_default_size(640, 720);
        window.add(this._buildGroupsPage());
        window.add(this._buildAppearancePage());

        const groupsId = this._settings.connect('changed::groups', () => this._rebuildSoon());
        const favsId = this._shellSettings.connect('changed::favorite-apps', () => this._rebuildSoon());
        window.connect('close-request', () => {
            this._settings.disconnect(groupsId);
            this._shellSettings.disconnect(favsId);
            if (this._rebuildId)
                GLib.source_remove(this._rebuildId);
            if (this._iconTimerId)
                GLib.source_remove(this._iconTimerId);
            return false;
        });
    }

    // ---- model -----------------------------------------------------------

    _groups() {
        return parseJson(this._settings.get_string('groups'), []);
    }

    _saveGroups(groups) {
        this._settings.set_string('groups', JSON.stringify(groups));
    }

    _updateGroup(id, fn) {
        const groups = this._groups();
        const g = groups.find(x => x.id === id);
        if (!g)
            return;
        fn(g, groups);
        this._saveGroups(groups);
    }

    // ---- groups page -----------------------------------------------------

    _buildGroupsPage() {
        const page = new Adw.PreferencesPage({
            title: 'Skupiny',
            icon_name: 'view-app-grid-symbolic',
        });

        this._groupsGroup = new Adw.PreferencesGroup({
            title: 'Skupiny v docku',
            description: 'Klikni na skupinu v docku a otvorí sa okno s jej aplikáciami.',
        });
        const addButton = new Gtk.Button({
            child: new Adw.ButtonContent({icon_name: 'list-add-symbolic', label: 'Nová skupina'}),
            css_classes: ['suggested-action'],
            valign: Gtk.Align.CENTER,
        });
        addButton.connect('clicked', () => this._createGroup());
        this._groupsGroup.set_header_suffix(addButton);
        page.add(this._groupsGroup);

        this._rebuild();
        return page;
    }

    _rebuildSoon() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
        // The extension regenerates the composite icons shortly after a
        // change; refresh once more to pick them up.
        if (this._iconTimerId)
            GLib.source_remove(this._iconTimerId);
        this._iconTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._iconTimerId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        for (const row of this._rows)
            this._groupsGroup.remove(row);
        this._rows = [];

        const groups = this._groups();
        const favorites = this._shellSettings.get_strv('favorite-apps');

        if (groups.length === 0) {
            const row = new Adw.ActionRow({
                title: 'Zatiaľ žiadne skupiny',
                subtitle: 'Vytvor prvú pomocou tlačidla „Nová skupina“.',
            });
            row.add_prefix(Gtk.Image.new_from_icon_name('folder-new-symbolic'));
            this._addRow(row);
            return;
        }

        groups.forEach((group, index) => this._addRow(this._groupRow(group, index, groups.length, favorites)));
    }

    _addRow(row) {
        this._groupsGroup.add(row);
        this._rows.push(row);
    }

    _groupRow(group, index, count, favorites) {
        const row = new Adw.ExpanderRow({
            title: GLib.markup_escape_text(group.name || 'Skupina', -1),
            subtitle: appCountLabel(group.apps.length),
            expanded: this._expanded.has(group.id),
        });
        const icon = groupIcon(group.id);
        icon.set_pixel_size(40);
        row.add_prefix(icon);
        row.connect('notify::expanded', () => {
            if (row.expanded)
                this._expanded.add(group.id);
            else
                this._expanded.delete(group.id);
        });

        // Move the whole group up/down in this list.
        const moveBox = new Gtk.Box({spacing: 4, valign: Gtk.Align.CENTER});
        moveBox.append(this._iconButton('go-up-symbolic', 'Posunúť vyššie', index > 0,
            () => this._moveGroup(group.id, -1)));
        moveBox.append(this._iconButton('go-down-symbolic', 'Posunúť nižšie', index < count - 1,
            () => this._moveGroup(group.id, 1)));
        row.add_suffix(moveBox);

        const nameRow = new Adw.EntryRow({
            title: 'Názov skupiny',
            text: group.name ?? '',
            show_apply_button: true,
        });
        nameRow.connect('apply', () => {
            const name = nameRow.text.trim() || 'Skupina';
            this._updateGroup(group.id, g => (g.name = name));
        });
        row.add_row(nameRow);

        const dockRow = new Adw.SwitchRow({
            title: 'Zobraziť v docku',
            active: favorites.includes(desktopIdFor(group.id)),
        });
        dockRow.connect('notify::active', () => this._setInDock(group.id, dockRow.active));
        row.add_row(dockRow);

        group.apps.forEach((appId, i) => {
            const info = lookupApp(appId);
            const appRow = new Adw.ActionRow({
                title: GLib.markup_escape_text(info?.get_name() ?? appId, -1),
                subtitle: info ? '' : 'Aplikácia nie je nainštalovaná',
            });
            const img = info?.get_icon()
                ? Gtk.Image.new_from_gicon(info.get_icon())
                : Gtk.Image.new_from_icon_name('application-x-executable-symbolic');
            img.set_pixel_size(32);
            appRow.add_prefix(img);

            appRow.add_suffix(this._iconButton('go-up-symbolic', 'Posunúť vyššie', i > 0,
                () => this._moveApp(group.id, i, -1)));
            appRow.add_suffix(this._iconButton('go-down-symbolic', 'Posunúť nižšie', i < group.apps.length - 1,
                () => this._moveApp(group.id, i, 1)));
            appRow.add_suffix(this._iconButton('list-remove-symbolic', 'Odobrať zo skupiny', true,
                () => this._updateGroup(group.id, g => g.apps.splice(i, 1))));
            row.add_row(appRow);
        });

        const addApps = new Adw.ButtonRow({
            title: 'Pridať aplikácie…',
            start_icon_name: 'list-add-symbolic',
        });
        addApps.connect('activated', () => this._chooseApps(group));
        row.add_row(addApps);

        const remove = new Adw.ButtonRow({
            title: 'Odstrániť skupinu',
            start_icon_name: 'user-trash-symbolic',
            css_classes: ['destructive-action'],
        });
        remove.connect('activated', () => this._confirmDelete(group));
        row.add_row(remove);

        return row;
    }

    _iconButton(icon, tooltip, sensitive, cb) {
        const b = new Gtk.Button({
            icon_name: icon,
            tooltip_text: tooltip,
            sensitive,
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'circular'],
        });
        b.connect('clicked', cb);
        return b;
    }

    _moveGroup(id, delta) {
        const groups = this._groups();
        const i = groups.findIndex(g => g.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= groups.length)
            return;
        [groups[i], groups[j]] = [groups[j], groups[i]];
        this._saveGroups(groups);
    }

    _moveApp(groupId, i, delta) {
        this._updateGroup(groupId, g => {
            const j = i + delta;
            if (j < 0 || j >= g.apps.length)
                return;
            [g.apps[i], g.apps[j]] = [g.apps[j], g.apps[i]];
        });
    }

    _setInDock(groupId, inDock) {
        const desktopId = desktopIdFor(groupId);
        let favs = this._shellSettings.get_strv('favorite-apps');
        if (inDock === favs.includes(desktopId))
            return;
        favs = inDock ? [...favs, desktopId] : favs.filter(id => id !== desktopId);
        this._shellSettings.set_strv('favorite-apps', favs);
    }

    _confirmDelete(group) {
        const dialog = new Adw.AlertDialog({
            heading: `Odstrániť skupinu „${group.name}“?`,
            body: 'Aplikácie zo skupiny sa vrátia späť do docku.',
        });
        dialog.add_response('cancel', 'Zrušiť');
        dialog.add_response('delete', 'Odstrániť');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.set_default_response('cancel');
        dialog.connect('response', (_d, response) => {
            if (response !== 'delete')
                return;
            this._saveGroups(this._groups().filter(g => g.id !== group.id));
        });
        dialog.present(this._window);
    }

    _createGroup() {
        this._chooseApps(null);
    }

    // App chooser: used both for a new group (group === null) and for adding
    // apps to an existing one.
    _chooseApps(group) {
        const isNew = group === null;
        const groups = this._groups();
        const memberOf = new Map();
        for (const g of groups) {
            for (const id of g.apps)
                memberOf.set(id, g.name);
        }

        const dialog = new Adw.Dialog({
            title: isNew ? 'Nová skupina' : `Pridať do „${group.name}“`,
            content_width: 440,
            content_height: 620,
        });
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar({show_end_title_buttons: false, show_start_title_buttons: false});
        const cancel = new Gtk.Button({label: 'Zrušiť'});
        const confirm = new Gtk.Button({
            label: isNew ? 'Vytvoriť' : 'Pridať',
            css_classes: ['suggested-action'],
            sensitive: isNew,
        });
        header.pack_start(cancel);
        header.pack_end(confirm);
        toolbar.add_top_bar(header);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        let nameEntry = null;
        if (isNew) {
            const nameList = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE});
            nameEntry = new Adw.EntryRow({title: 'Názov skupiny', text: 'Nová skupina'});
            nameList.append(nameEntry);
            content.append(nameList);
        }

        const search = new Gtk.SearchEntry({placeholder_text: 'Hľadať aplikácie…'});
        content.append(search);

        const list = new Gtk.ListBox({
            css_classes: ['boxed-list'],
            selection_mode: Gtk.SelectionMode.NONE,
            valign: Gtk.Align.START,
        });
        const scrolled = new Gtk.ScrolledWindow({
            child: list,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        content.append(scrolled);
        toolbar.set_content(content);
        dialog.set_child(toolbar);

        const selected = [];
        const existing = new Set(group?.apps ?? []);
        for (const info of allApps()) {
            if (existing.has(info.get_id()))
                continue;
            const check = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
            const other = memberOf.get(info.get_id());
            const row = new Adw.ActionRow({
                title: GLib.markup_escape_text(info.get_name(), -1),
                subtitle: other ? GLib.markup_escape_text(`Už v skupine „${other}“`, -1) : '',
                activatable_widget: check,
            });
            row._name = info.get_name().toLowerCase();
            row._id = info.get_id().toLowerCase();
            const img = info.get_icon()
                ? Gtk.Image.new_from_gicon(info.get_icon())
                : Gtk.Image.new_from_icon_name('application-x-executable-symbolic');
            img.set_pixel_size(32);
            row.add_prefix(check);
            row.add_prefix(img);
            check.connect('toggled', () => {
                const id = info.get_id();
                const idx = selected.indexOf(id);
                if (check.active && idx < 0)
                    selected.push(id);
                else if (!check.active && idx >= 0)
                    selected.splice(idx, 1);
                confirm.sensitive = isNew || selected.length > 0;
            });
            list.append(row);
        }

        list.set_filter_func(row => {
            const q = search.text.trim().toLowerCase();
            return !q || row._name.includes(q) || row._id.includes(q);
        });
        search.connect('search-changed', () => list.invalidate_filter());

        cancel.connect('clicked', () => dialog.close());
        confirm.connect('clicked', () => {
            if (isNew) {
                const all = this._groups();
                const id = newId();
                all.push({
                    id,
                    name: nameEntry.text.trim() || 'Nová skupina',
                    apps: [...selected],
                });
                this._expanded.add(id);
                this._saveGroups(all);
            } else {
                this._updateGroup(group.id, g => {
                    for (const id of selected) {
                        if (!g.apps.includes(id))
                            g.apps.push(id);
                    }
                });
            }
            dialog.close();
        });

        dialog.present(this._window);
        (nameEntry ?? search).grab_focus();
    }

    // ---- appearance page -------------------------------------------------

    _buildAppearancePage() {
        const page = new Adw.PreferencesPage({
            title: 'Vzhľad a správanie',
            icon_name: 'preferences-desktop-appearance-symbolic',
        });

        const look = new Adw.PreferencesGroup({title: 'Okno skupiny'});
        page.add(look);

        const iconSize = Adw.SpinRow.new_with_range(32, 128, 8);
        iconSize.set({title: 'Veľkosť ikon', subtitle: 'v pixeloch'});
        this._settings.bind('icon-size', iconSize, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(iconSize);

        const cols = Adw.SpinRow.new_with_range(0, 8, 1);
        cols.set({title: 'Počet stĺpcov', subtitle: '0 = automaticky podľa počtu aplikácií'});
        this._settings.bind('columns', cols, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(cols);

        const labels = new Adw.SwitchRow({title: 'Zobraziť názvy aplikácií'});
        this._settings.bind('show-labels', labels, 'active', Gio.SettingsBindFlags.DEFAULT);
        look.add(labels);

        const speed = Adw.SpinRow.new_with_range(0.25, 3, 0.25);
        speed.set({title: 'Dĺžka animácií', subtitle: '1 = normálna, menej = rýchlejšie', digits: 2});
        this._settings.bind('animation-speed', speed, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(speed);

        const behaviour = new Adw.PreferencesGroup({title: 'Dock'});
        page.add(behaviour);

        const removeMembers = new Adw.SwitchRow({
            title: 'Presunúť aplikácie do skupiny',
            subtitle: 'Aplikácia pridaná do skupiny zmizne zo svojho samostatného miesta v docku',
        });
        this._settings.bind('remove-members-from-dock', removeMembers, 'active', Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(removeMembers);

        return page;
    }
}
