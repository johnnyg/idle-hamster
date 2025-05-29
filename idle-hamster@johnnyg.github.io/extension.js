/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

Gio._promisify(Gio.DBusProxy, 'new_for_bus');
Gio._promisify(Gio.DBusProxy.prototype, 'call');

const IDLE_TIME = 60 * 1000; // 1min

export default class IdleHamsterExtension extends Extension {
    async enable() {
        this._hamsterProxy = await Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION,
          Gio.DBusProxyFlags.NONE,
          null,
          'org.gnome.Hamster',
          '/org/gnome/Hamster',
          'org.gnome.Hamster',
          null);
        this._idleMonitorProxy = await Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION,
          Gio.DBusProxyFlags.NONE,
          null,
          'org.gnome.Mutter.IdleMonitor',
          '/org/gnome/Mutter/IdleMonitor/Core',
          'org.gnome.Mutter.IdleMonitor',
          null);
        this._idleMonitorProxy.connect('g-signal', async (_proxy, senderName, signalName, parameters) => {
          if (signalName === 'WatchFired') {
            const [idleTime] = (await this._idleMonitorProxy.call('GetIdletime', null, Gio.DBusCallFlags.NONE, -1, null)).deepUnpack();
            console.log(`idle time: ${idleTime}`);
            const lastActiveTime = Math.floor((Date.now() - idleTime) / 1000);
            // Workaround for https://github.com/projecthamster/hamster/issues/775
            const endTime = lastActiveTime - (new Date().getTimezoneOffset() * 60);
            await this._hamsterProxy.call('StopTracking', new GLib.Variant('(i)', [endTime]), Gio.DBusCallFlags.NONE, -1, null);
            Main.notify(_("Hamster tracking was stopped due to being idle"));
          }
        });
        const watch_id = (await this._idleMonitorProxy.call('AddIdleWatch', new GLib.Variant('(t)', [IDLE_TIME]), Gio.DBusCallFlags.NONE, -1, null)).deepUnpack();
        console.log(`watch ID: ${watch_id}`);
        this._watch_id = watch_id
    }

    async disable() {
        this._indicator.destroy();
        this._indicator = null;
        await this._idleMonitorProxy.call('RemoveIdleWatch', new GLib.Variant('(u)', [this._watch_id]), Gio.DBusCallFlags.NONE, -1, null);
        this._watch_id = null;
    }
}
