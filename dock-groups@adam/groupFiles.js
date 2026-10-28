// Generates the .desktop launchers and composite icons that represent
// groups in the dock. Each group becomes a pseudo-application
// "dock-group-<id>.desktop" which the extension intercepts on activation.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import St from 'gi://St';

export const GROUP_PREFIX = 'dock-group-';
export const DBUS_PATH = '/org/gnome/Shell/Extensions/DockGroups';
export const DBUS_IFACE = 'org.gnome.Shell.Extensions.DockGroups';

const ICON_SIZE = 256;

const appsDir = () => GLib.build_filenamev([GLib.get_user_data_dir(), 'applications']);
const iconsDir = () => GLib.build_filenamev([GLib.get_user_data_dir(), 'dock-groups', 'icons']);

export const desktopIdFor = groupId => `${GROUP_PREFIX}${groupId}.desktop`;

export function groupIdFromAppId(appId) {
    if (!appId?.startsWith(GROUP_PREFIX) || !appId.endsWith('.desktop'))
        return null;
    return appId.slice(GROUP_PREFIX.length, -'.desktop'.length);
}

function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++)
        h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(16);
}

function readText(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

let _iconTheme = null;

function iconPathFor(gicon, size) {
    if (!gicon)
        return null;
    if (gicon instanceof Gio.FileIcon)
        return gicon.get_file().get_path();
    _iconTheme ??= new St.IconTheme();
    const info = _iconTheme.lookup_by_gicon(gicon, size, St.IconLookupFlags.FORCE_SIZE);
    return info?.get_filename() ?? null;
}

function renderIcon(extensionPath, iconPaths, outPath) {
    const bg = GdkPixbuf.Pixbuf.new_from_file_at_size(
        GLib.build_filenamev([extensionPath, 'media', 'group-bg.svg']), ICON_SIZE, ICON_SIZE);

    const n = iconPaths.length > 4 ? 3 : 2;
    const pad = n === 2 ? 40 : 38;
    const gap = n === 2 ? 16 : 10;
    const cell = Math.floor((ICON_SIZE - 2 * pad - (n - 1) * gap) / n);

    iconPaths.slice(0, n * n).forEach((path, i) => {
        let pix;
        try {
            pix = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, cell, cell, true);
        } catch {
            return;
        }
        const col = i % n, row = Math.floor(i / n);
        const x = pad + col * (cell + gap) + Math.floor((cell - pix.get_width()) / 2);
        const y = pad + row * (cell + gap) + Math.floor((cell - pix.get_height()) / 2);
        pix.composite(bg, x, y, pix.get_width(), pix.get_height(),
            x, y, 1, 1, GdkPixbuf.InterpType.HYPER, 255);
    });

    bg.savev(outPath, 'png', [], []);
}

function escapeDesktopValue(str) {
    return str.replace(/\\/g, '\\\\').replace(/\n/g, ' ');
}

/**
 * Writes the launcher and icon for a group. Returns true when the
 * .desktop file changed (so the dock should refresh its icon).
 */
export function writeGroup(extensionPath, uuid, group, lookupApp) {
    GLib.mkdir_with_parents(appsDir(), 0o755);
    GLib.mkdir_with_parents(iconsDir(), 0o755);

    const iconPaths = group.apps
        .map(id => lookupApp(id))
        .filter(app => app)
        .map(app => iconPathFor(app.get_icon(), 128) ??
            iconPathFor(new Gio.ThemedIcon({name: 'application-x-executable'}), 128))
        .filter(p => p);

    const key = hash(`${iconPaths.join('|')}#v2`);
    const iconPath = GLib.build_filenamev([iconsDir(), `${group.id}-${key}.png`]);
    if (!GLib.file_test(iconPath, GLib.FileTest.EXISTS)) {
        try {
            renderIcon(extensionPath, iconPaths, iconPath);
        } catch (e) {
            console.error(`[dock-groups] icon render failed: ${e}`);
        }
    }
    removeIcons(group.id, iconPath);

    const exec = `sh -c "gdbus call --session --dest org.gnome.Shell ` +
        `--object-path ${DBUS_PATH} --method ${DBUS_IFACE}.Open ${group.id} ` +
        `|| gnome-extensions prefs ${uuid}"`;

    const content = [
        '[Desktop Entry]',
        'Type=Application',
        `Name=${escapeDesktopValue(group.name || 'Skupina')}`,
        'Comment=Skupina aplikácií (Dock Groups)',
        `Icon=${iconPath}`,
        `Exec=${exec}`,
        'StartupNotify=false',
        `X-DockGroups-Id=${group.id}`,
        '',
    ].join('\n');

    const desktopPath = GLib.build_filenamev([appsDir(), desktopIdFor(group.id)]);
    if (readText(desktopPath) === content)
        return false;
    GLib.file_set_contents(desktopPath, content);
    return true;
}

function removeIcons(groupId, keepPath = null) {
    const dir = Gio.File.new_for_path(iconsDir());
    let en;
    try {
        en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return;
    }
    let info;
    while ((info = en.next_file(null))) {
        const name = info.get_name();
        if (!name.startsWith(`${groupId}-`))
            continue;
        const child = dir.get_child(name);
        if (child.get_path() !== keepPath)
            child.delete(null);
    }
    en.close(null);
}

export function removeGroup(groupId) {
    try {
        Gio.File.new_for_path(
            GLib.build_filenamev([appsDir(), desktopIdFor(groupId)])).delete(null);
    } catch {}
    removeIcons(groupId);
}

/** Ids of all group launchers present on disk. */
export function listGroupIdsOnDisk() {
    const ids = [];
    const dir = Gio.File.new_for_path(appsDir());
    let en;
    try {
        en = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return ids;
    }
    let info;
    while ((info = en.next_file(null))) {
        const id = groupIdFromAppId(info.get_name());
        if (id)
            ids.push(id);
    }
    en.close(null);
    return ids;
}
