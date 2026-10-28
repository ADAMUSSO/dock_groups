// The animated popup that shows the applications of a group, anchored
// to the group's icon in the dock.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const GAP = 14;          // distance between the dock icon and the panel
const SCREEN_MARGIN = 10;
const STAGGER_IN = 22;   // ms between items when opening
const STAGGER_OUT = 10;  // ms between items when closing

const Edge = {BOTTOM: 0, TOP: 1, LEFT: 2, RIGHT: 3};

const GroupItem = GObject.registerClass({
    Signals: {'launch': {param_types: [GObject.TYPE_BOOLEAN]}},
}, class GroupItem extends St.Button {
    _init(app, iconSize, showLabel) {
        super._init({
            style_class: 'dock-groups-item',
            can_focus: true,
            track_hover: true,
            reactive: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO,
            x_expand: false,
        });
        this.app = app;

        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.set_child(box);

        this._icon = app.create_icon_texture(iconSize);
        this._icon.set({x_align: Clutter.ActorAlign.CENTER});
        this._icon.set_pivot_point(0.5, 0.5);
        box.add_child(this._icon);

        this._dot = new St.Widget({
            style_class: 'dock-groups-running-dot',
            x_align: Clutter.ActorAlign.CENTER,
            opacity: app.state === Shell.AppState.STOPPED ? 0 : 255,
        });
        box.add_child(this._dot);

        if (showLabel) {
            const label = new St.Label({
                text: app.get_name(),
                style_class: 'dock-groups-item-label',
                x_align: Clutter.ActorAlign.CENTER,
            });
            label.clutter_text.set({
                ellipsize: Pango.EllipsizeMode.END,
                line_alignment: Pango.Alignment.CENTER,
            });
            label.set_style(`max-width: ${iconSize + 28}px;`);
            box.add_child(label);
        }
        this.set_style(`width: ${iconSize + 36}px;`);
        this.set_pivot_point(0.5, 0.5);

        this.connect('clicked', (_b, button) => this.emit('launch', button === Clutter.BUTTON_MIDDLE));
        this.connect('notify::hover', () => this._updateHover());
        this.connect('key-focus-in', () => this._updateHover());
        this.connect('key-focus-out', () => this._updateHover());
    }

    _updateHover() {
        const active = this.hover || this.has_key_focus();
        this._icon.ease({
            scale_x: active ? 1.12 : 1,
            scale_y: active ? 1.12 : 1,
            duration: 160,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    vfunc_key_press_event(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter || sym === Clutter.KEY_space) {
            this.emit('launch', (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0);
            return Clutter.EVENT_STOP;
        }
        return super.vfunc_key_press_event(event);
    }
});

export class GroupPopup {
    constructor({group, apps, sourceActor, settings, onClosing, onClosed}) {
        this._group = group;
        this._apps = apps;
        this._source = sourceActor;
        this._settings = settings;
        this._onClosing = onClosing;
        this._onClosed = onClosed;
        this._speed = settings.get_double('animation-speed');
        this._closing = false;
        this._items = [];
    }

    get groupId() {
        return this._group.id;
    }

    get isClosing() {
        return this._closing;
    }

    _d(ms) {
        return Math.round(ms * this._speed);
    }

    open() {
        const iconSize = this._settings.get_int('icon-size');
        const showLabels = this._settings.get_boolean('show-labels');

        this._backdrop = new St.Widget({
            reactive: true,
            can_focus: true,
            style_class: 'dock-groups-backdrop',
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
            opacity: 0,
        });
        // Clicks outside the panel close the popup. Don't stop events inside
        // the panel: the item buttons' click gestures need them to bubble.
        this._backdrop.connect('button-press-event', (_a, event) => {
            if (!this._isOutsidePanel(event))
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.connect('touch-event', (_a, event) => {
            if (!this._isOutsidePanel(event))
                return Clutter.EVENT_PROPAGATE;
            if (event.type() === Clutter.EventType.TOUCH_BEGIN)
                this.close();
            return Clutter.EVENT_STOP;
        });
        this._backdrop.connect('key-press-event', (_a, event) => this._onKeyPress(event));
        this._backdrop.connect('scroll-event', () => Clutter.EVENT_STOP);

        this._panel = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'dock-groups-panel',
            reactive: true,
            opacity: 0,
        });
        this._backdrop.add_child(this._panel);

        const title = new St.Label({
            text: this._group.name || 'Skupina',
            style_class: 'dock-groups-title',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._panel.add_child(title);

        const layout = new Clutter.GridLayout({
            column_homogeneous: true,
            row_homogeneous: true,
        });
        this._grid = new St.Widget({
            layout_manager: layout,
            style_class: 'dock-groups-grid',
            x_align: Clutter.ActorAlign.CENTER,
        });
        layout.set_column_spacing(6);
        layout.set_row_spacing(10);
        this._panel.add_child(this._grid);

        let cols = this._settings.get_int('columns');
        if (cols <= 0)
            cols = Math.min(Math.max(Math.ceil(Math.sqrt(this._apps.length)), 1), 6);

        if (this._apps.length === 0) {
            const empty = new St.Label({
                text: 'Skupina je prázdna.\nPridaj aplikácie v nastaveniach.',
                style_class: 'dock-groups-empty',
            });
            layout.attach(empty, 0, 0, 1, 1);
        }

        this._apps.forEach((app, i) => {
            const item = new GroupItem(app, iconSize, showLabels);
            item.connect('launch', (_i, newWindow) => this._launch(item, newWindow));
            item.opacity = 0;
            layout.attach(item, i % cols, Math.floor(i / cols), 1, 1);
            this._items.push(item);
        });
        this._cols = cols;

        Main.layoutManager.uiGroup.add_child(this._backdrop);
        this._grab = Main.pushModal(this._backdrop, {actionMode: Shell.ActionMode.POPUP});

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this.close(false));
        this._place();

        global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (!this._closing)
                this._animateIn();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    _isOutsidePanel(event) {
        const target = global.stage.get_event_actor(event);
        return !this._panel || !this._panel.contains(target);
    }

    _sourceRect() {
        if (this._source?.get_stage()) {
            const [x, y] = this._source.get_transformed_position();
            const [w, h] = this._source.get_transformed_size();
            if (w > 0 && h > 0)
                return {x, y, w, h};
        }
        const [px, py] = global.get_pointer();
        return {x: px - 1, y: py - 1, w: 2, h: 2};
    }

    _place() {
        const r = this._sourceRect();
        this._anchor = {x: r.x + r.w / 2, y: r.y + r.h / 2};

        const monitorIndex = global.display.get_monitor_index_for_rect(
            new Mtk.Rectangle({x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.w)), height: Math.max(1, Math.round(r.h))}));
        const mon = Main.layoutManager.monitors[monitorIndex] ?? Main.layoutManager.primaryMonitor;

        const dist = [
            mon.y + mon.height - (r.y + r.h),
            r.y - mon.y,
            r.x - mon.x,
            mon.x + mon.width - (r.x + r.w),
        ];
        const edge = dist.indexOf(Math.min(...dist));
        this._edge = edge;

        const [, natW] = this._panel.get_preferred_width(-1);
        const [, natH] = this._panel.get_preferred_height(natW);
        const w = Math.min(natW, mon.width - 2 * SCREEN_MARGIN);
        const h = Math.min(natH, mon.height - 2 * SCREEN_MARGIN);

        let x, y;
        switch (edge) {
        case Edge.TOP:
            x = this._anchor.x - w / 2;
            y = r.y + r.h + GAP;
            break;
        case Edge.LEFT:
            x = r.x + r.w + GAP;
            y = this._anchor.y - h / 2;
            break;
        case Edge.RIGHT:
            x = r.x - GAP - w;
            y = this._anchor.y - h / 2;
            break;
        default:
            x = this._anchor.x - w / 2;
            y = r.y - GAP - h;
        }

        // Keep clear of the top bar etc., but the dock itself may reserve a
        // strut, so only clamp along the axis parallel to the dock edge.
        const wa = Main.layoutManager.getWorkAreaForMonitor(mon.index ?? monitorIndex);
        const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(v, hi)));
        if (edge === Edge.LEFT || edge === Edge.RIGHT)
            y = clamp(y, wa.y + SCREEN_MARGIN, wa.y + wa.height - SCREEN_MARGIN - h);
        else
            x = clamp(x, wa.x + SCREEN_MARGIN, wa.x + wa.width - SCREEN_MARGIN - w);
        x = clamp(x, mon.x + SCREEN_MARGIN, mon.x + mon.width - SCREEN_MARGIN - w);
        y = clamp(y, mon.y + SCREEN_MARGIN, mon.y + mon.height - SCREEN_MARGIN - h);

        this._panel.set_position(x, y);
        this._panel.set_size(w, h);
        this._panel.set_pivot_point((this._anchor.x - x) / w, (this._anchor.y - y) / h);
    }

    // Offset that moves an item's centre onto the dock icon, expressed in the
    // grid's (unscaled) coordinate space.
    _offsetToAnchor(item) {
        const box = item.get_allocation_box();
        const gridBox = this._grid.get_allocation_box();
        const cx = this._panel.x + gridBox.x1 + (box.x1 + box.x2) / 2;
        const cy = this._panel.y + gridBox.y1 + (box.y1 + box.y2) / 2;
        return [this._anchor.x - cx, this._anchor.y - cy];
    }

    _animateIn() {
        this._backdrop.ease({
            opacity: 255,
            duration: this._d(220),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        const startScale = 0.55;
        this._panel.set({scale_x: startScale, scale_y: startScale});
        this._panel.ease({
            opacity: 255,
            duration: this._d(200),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._panel.ease({
            scale_x: 1,
            scale_y: 1,
            duration: this._d(360),
            mode: Clutter.AnimationMode.EASE_OUT_BACK,
        });

        this._items.forEach((item, i) => {
            const [dx, dy] = this._offsetToAnchor(item);
            item.set({
                translation_x: dx,
                translation_y: dy,
                scale_x: 0.3,
                scale_y: 0.3,
                opacity: 0,
            });
            const delay = this._d(40 + i * STAGGER_IN);
            item.ease({
                translation_x: 0,
                translation_y: 0,
                duration: this._d(380),
                delay,
                mode: Clutter.AnimationMode.EASE_OUT_EXPO,
            });
            item.ease({
                scale_x: 1,
                scale_y: 1,
                duration: this._d(420),
                delay,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
            item.ease({
                opacity: 255,
                duration: this._d(180),
                delay,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });

        // Focus the backdrop so Escape works; arrow keys move into the grid.
        this._backdrop.grab_key_focus();
    }

    _launch(item, newWindow) {
        if (this._closing)
            return;
        const app = item.app;

        // Little "pop" on the chosen app while the rest fly back home.
        item.remove_all_transitions();
        item.ease({
            scale_x: 1.25,
            scale_y: 1.25,
            opacity: 0,
            duration: this._d(260),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.close(true, item);

        if (Main.overview.visible)
            Main.overview.hide();
        if (newWindow && app.can_open_new_window())
            app.open_new_window(-1);
        else
            app.activate();
    }

    _onKeyPress(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        const dirs = {
            [Clutter.KEY_Left]: St.DirectionType.LEFT,
            [Clutter.KEY_Right]: St.DirectionType.RIGHT,
            [Clutter.KEY_Up]: St.DirectionType.UP,
            [Clutter.KEY_Down]: St.DirectionType.DOWN,
            [Clutter.KEY_Tab]: St.DirectionType.TAB_FORWARD,
            [Clutter.KEY_ISO_Left_Tab]: St.DirectionType.TAB_BACKWARD,
        };
        if (sym in dirs) {
            const focus = global.stage.get_key_focus();
            if (!this._items.includes(focus)) {
                this._items[0]?.grab_key_focus();
            } else {
                this._grid.navigate_focus(focus, dirs[sym], true);
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    close(animate = true, launchedItem = null) {
        if (this._closing)
            return;
        this._closing = true;

        const closing = this._onClosing;
        this._onClosing = null;

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        closing?.(launchedItem !== null);
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        if (!this._backdrop)
            return;
        this._backdrop.reactive = false;

        if (!animate || this._speed <= 0) {
            this._destroy();
            return;
        }

        this._backdrop.ease({
            opacity: 0,
            duration: this._d(240),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        const n = this._items.length;
        this._items.forEach((item, i) => {
            if (item === launchedItem)
                return;
            item.remove_all_transitions();
            const [dx, dy] = this._offsetToAnchor(item);
            item.ease({
                translation_x: dx,
                translation_y: dy,
                scale_x: 0.25,
                scale_y: 0.25,
                opacity: 0,
                duration: this._d(230),
                delay: this._d((n - 1 - i) * STAGGER_OUT),
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
            });
        });

        this._panel.remove_all_transitions();
        this._panel.ease({
            scale_x: 0.6,
            scale_y: 0.6,
            opacity: 0,
            duration: this._d(240),
            delay: this._d(Math.min(n * STAGGER_OUT, 80)),
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => this._destroy(),
        });
    }

    _destroy() {
        if (this._backdrop) {
            this._backdrop.destroy();
            this._backdrop = null;
        }
        this._items = [];
        const cb = this._onClosed;
        this._onClosed = null;
        cb?.(this);
    }
}
