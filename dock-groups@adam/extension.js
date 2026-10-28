// Dock Groups: folders of applications in the dock.
//
// Every group is represented by a generated launcher "dock-group-<id>.desktop"
// that lives in the dock's favourites like any other app. Activating it is
// intercepted (Shell.App methods are patched) and an animated popup with the
// group's applications is shown instead.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Files from './groupFiles.js';
import {GroupPopup} from './popup.js';

const DBUS_XML = `
<node>
  <interface name="${Files.DBUS_IFACE}">
    <method name="Open">
      <arg type="s" direction="in" name="groupId"/>
    </method>
  </interface>
</node>`;

const INTERCEPTED_METHODS = ['activate', 'activate_full', 'open_new_window', 'launch'];

function parseJson(str, fallback) {
    try {
        return JSON.parse(str) ?? fallback;
    } catch {
        return fallback;
    }
}

export default class DockGroupsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._shellSettings = new Gio.Settings({schema_id: 'org.gnome.shell'});
        this._appSystem = Shell.AppSystem.get_default();
        this._popup = null;
        this._pendingIconRefresh = new Set();

        this._injections = new InjectionManager();
        const ext = this;
        for (const name of INTERCEPTED_METHODS) {
            this._injections.overrideMethod(Shell.App.prototype, name, original => {
                return function (...args) {
                    const groupId = Files.groupIdFromAppId(this.get_id());
                    if (groupId !== null) {
                        ext._holdOverview();
                        ext.toggleGroup(groupId);
                        return name === 'launch' ? true : undefined;
                    }
                    return original.apply(this, args);
                };
            });
        }

        // The dock (and the overview dash) hide the overview right after
        // activating an app. For a group that must wait until an app from
        // the popup is actually launched, so swallow that one hide().
        this._injections.overrideMethod(Main.overview, 'hide', original => {
            return function (...args) {
                if (ext._overviewHoldId)
                    return undefined;
                return original.apply(this, args);
            };
        });

        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, this);
        this._dbus.export(Gio.DBus.session, Files.DBUS_PATH);

        this._settings.connectObject('changed::groups', () => this._queueSync(), this);
        this._appSystem.connectObject('installed-changed', () => this._refreshDockIcons(), this);

        // The icon theme may have changed since the icons were rendered.
        this._sync();
    }

    disable() {
        this._popup?.close(false);
        this._popup = null;

        if (this._dockReleaseId) {
            GLib.source_remove(this._dockReleaseId);
            this._dockReleaseId = 0;
        }
        this._pendingDockRelease?.();
        this._pendingDockRelease = null;

        if (this._overviewHoldId) {
            GLib.source_remove(this._overviewHoldId);
            this._overviewHoldId = 0;
        }

        if (this._syncId) {
            GLib.source_remove(this._syncId);
            this._syncId = 0;
        }

        this._dbus?.unexport();
        this._dbus = null;

        this._injections?.clear();
        this._injections = null;

        this._settings?.disconnectObject(this);
        this._appSystem?.disconnectObject(this);
        this._settings = null;
        this._shellSettings = null;
        this._appSystem = null;
        this._pendingIconRefresh = null;
    }

    // D-Bus method, used by the launcher's Exec line as a fallback.
    Open(groupId) {
        this.toggleGroup(groupId);
    }

    // Blocks Main.overview.hide() until the current event has been handled.
    _holdOverview() {
        if (!Main.overview.visible || this._overviewHoldId)
            return;
        this._overviewHoldId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._overviewHoldId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _groups() {
        return parseJson(this._settings.get_string('groups'), [])
            .filter(g => g && typeof g.id === 'string' && Array.isArray(g.apps));
    }

    toggleGroup(groupId) {
        if (this._popup && !this._popup.isClosing) {
            const sameGroup = this._popup.groupId === groupId;
            this._popup.close();
            if (sameGroup)
                return;
        }

        const group = this._groups().find(g => g.id === groupId);
        if (!group) {
            this.openPreferences();
            return;
        }

        const apps = group.apps
            .map(id => this._appSystem.lookup_app(id))
            .filter(app => app);

        const sourceActor = this._findDockIcon(Files.desktopIdFor(groupId));
        const releaseDock = this._holdDock(sourceActor);
        const popup = new GroupPopup({
            group,
            apps,
            sourceActor,
            settings: this._settings,
            // After launching an app the dock hides as usual right away.
            // Otherwise wait until the popup's backdrop is gone, so the dock
            // can see whether the pointer is still over it.
            onClosing: launched => {
                if (launched)
                    releaseDock();
            },
            onClosed: p => {
                releaseDock(true);
                if (this._popup === p)
                    this._popup = null;
            },
        });
        this._popup = popup;
        if (!popup.open())
            this._popup = null;
    }

    // Keeps an auto-hiding Ubuntu Dock / Dash to Dock visible while the
    // popup is open, the same way the dock does for its own context menus.
    // Returns a function that lets the dock hide again.
    _holdDock(sourceActor) {
        let dock = null;
        for (let a = sourceActor; a; a = a.get_parent()) {
            if (a.dash && 'requiresVisibility' in a.dash) {
                dock = a;
                break;
            }
        }
        if (!dock)
            return () => {};
        const dash = dock.dash;

        // Order matters: the visibility update triggered by
        // requiresVisibility resets the dock's ignore-hover flag, which
        // 'menu-opened' then sets again so losing hover to our grab
        // doesn't hide the dock.
        dash.requiresVisibility = true;
        dash.emit('menu-opened');
        let released = false;
        const release = () => {
            try {
                dock._box?.sync_hover();
                dash.requiresVisibility = false;
                dash.emit('menu-closed');
            } catch (e) {
                // The dock may have been rebuilt in the meantime.
                console.debug(`[dock-groups] releasing dock failed: ${e}`);
            }
        };
        return (deferred = false) => {
            if (released)
                return;
            released = true;
            if (!deferred) {
                release();
                return;
            }
            // Give the stage a frame to re-pick the actor under the pointer
            // now that the backdrop is destroyed.
            this._pendingDockRelease = release;
            this._dockReleaseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                this._dockReleaseId = 0;
                this._pendingDockRelease = null;
                release();
                return GLib.SOURCE_REMOVE;
            });
        };
    }

    _findDockIcons(appId) {
        const found = [];
        const walk = actor => {
            if (!actor.visible)
                return;
            const app = actor.app ?? actor._delegate?.app;
            if (app instanceof Shell.App && app.get_id() === appId && actor.is_mapped()) {
                found.push(actor);
                return;
            }
            for (const child of actor.get_children())
                walk(child);
        };
        walk(Main.layoutManager.uiGroup);
        return found;
    }

    // Prefer the icon under the pointer: the same group may be visible in
    // several docks (multi-monitor) or in the overview dash.
    _findDockIcon(appId) {
        const icons = this._findDockIcons(appId);
        const [px, py] = global.get_pointer();
        return icons.find(a => {
            const [x, y] = a.get_transformed_position();
            const [w, h] = a.get_transformed_size();
            return px >= x && px <= x + w && py >= y && py <= y + h;
        }) ?? icons[0] ?? null;
    }

    _refreshDockIcons() {
        if (!this._pendingIconRefresh?.size)
            return;
        for (const groupId of this._pendingIconRefresh) {
            for (const actor of this._findDockIcons(Files.desktopIdFor(groupId)))
                actor.icon?.update?.();
        }
        this._pendingIconRefresh.clear();
    }

    _queueSync() {
        if (this._syncId)
            return;
        this._syncId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._syncId = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Brings launchers, icons and the dock favourites in line with the
    // configured groups.
    _sync() {
        const groups = this._groups();
        // state: {groupId: [member ids already reflected in the dock]}
        const state = parseJson(this._settings.get_string('state'), {});
        const removeMembers = this._settings.get_boolean('remove-members-from-dock');
        let favorites = this._shellSettings.get_strv('favorite-apps');
        const origFavorites = favorites.join('\n');
        const lookup = id => this._appSystem.lookup_app(id);

        const allMembers = new Set(groups.flatMap(g => g.apps));
        const newState = {};

        for (const group of groups) {
            try {
                if (Files.writeGroup(this.path, this.uuid, group, lookup))
                    this._pendingIconRefresh.add(group.id);
            } catch (e) {
                console.error(`[dock-groups] failed to write group ${group.id}: ${e}`);
            }

            const desktopId = Files.desktopIdFor(group.id);
            const known = state[group.id];

            if (!known) {
                // Brand new group: put it into the dock where its first
                // member used to be.
                if (!favorites.includes(desktopId)) {
                    const pos = favorites.findIndex(id => group.apps.includes(id));
                    if (pos >= 0)
                        favorites.splice(pos, 0, desktopId);
                    else
                        favorites.push(desktopId);
                }
            }

            if (removeMembers) {
                const added = group.apps.filter(id => !(known ?? []).includes(id));
                favorites = favorites.filter(id => !added.includes(id));
            }
            newState[group.id] = [...group.apps];
        }

        // Deleted groups: drop the launcher and give the members their
        // place in the dock back.
        const liveIds = new Set(groups.map(g => g.id));
        const removedIds = new Set([
            ...Object.keys(state),
            ...Files.listGroupIdsOnDisk(),
        ].filter(id => !liveIds.has(id)));

        for (const groupId of removedIds) {
            const desktopId = Files.desktopIdFor(groupId);
            const pos = favorites.indexOf(desktopId);
            if (pos >= 0) {
                const restore = (state[groupId] ?? [])
                    .filter(id => !favorites.includes(id) && !allMembers.has(id) && lookup(id));
                favorites.splice(pos, 1, ...(removeMembers ? restore : []));
            }
            Files.removeGroup(groupId);
        }

        if (favorites.join('\n') !== origFavorites)
            this._shellSettings.set_strv('favorite-apps', favorites);
        this._settings.set_string('state', JSON.stringify(newState));

        if (this._popup && !this._popup.isClosing)
            this._popup.close(false);
    }
}
