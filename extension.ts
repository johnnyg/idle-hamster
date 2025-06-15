/* extension.ts
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

import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";

Gio._promisify(Gio.DBusProxy, "new_for_bus");
Gio._promisify(Gio.DBusProxy.prototype, "call");

const IDLE_DELAY_OFFSET_SEC = 12; // 10s to blank

// Alias `Gio.DBusProxy.new_for_bus` because `Gio._promisify` confuses typescript
type GioDBusProxyNewForBus = (
  bus_type: Gio.BusType,
  flags: Gio.DBusProxyFlags,
  info: Gio.DBusInterfaceInfo | null,
  name: string,
  object_path: string,
  interface_name: string,
  cancellable?: Gio.Cancellable | null
) => Promise<Gio.DBusProxy>;

function toTimeString(sec: number): string {
  return `${Math.floor(sec / 60)} min ${Math.floor(sec % 60)} sec`;
}

export default class IdleHamsterExtension extends Extension {
  _settings?: Gio.Settings;
  _sessionSettings?: Gio.Settings;
  _hamsterProxy?: Gio.DBusProxy;
  _idleMonitorProxy?: Gio.DBusProxy;
  _watchFiredHandlerId?: number;
  _idleDelayHandlerId?: number;
  _sessionIdleDelayHandlerId?: number;
  _useSessionIdleDelayHandlerId?: number;
  _watchId?: number;

  async enable(): Promise<void> {
    const logger = this.getLogger();
    logger.log("idle hamster enable");
    this._hamsterProxy = await (
      Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
    )(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      "org.gnome.Hamster",
      "/org/gnome/Hamster",
      "org.gnome.Hamster",
      null
    );
    this._idleMonitorProxy = await (
      Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
    )(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      "org.gnome.Mutter.IdleMonitor",
      "/org/gnome/Mutter/IdleMonitor/Core",
      "org.gnome.Mutter.IdleMonitor",
      null
    );
    this._watchFiredHandlerId = this._idleMonitorProxy!.connect(
      "g-signal::WatchFired",
      async (_proxy, _senderName, _signalName, _parameters) => {
        const idleTime = (
          await this._idleMonitorProxy!.call(
            "GetIdletime",
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null
          )
        )
          .get_child_value(0)
          .get_uint64();
        logger.log(`idle time: ${toTimeString(idleTime / 1000)}`);
        const lastActiveTime = Math.floor((Date.now() - idleTime) / 1000);
        // Workaround for https://github.com/projecthamster/hamster/issues/775
        const endTime = lastActiveTime - new Date().getTimezoneOffset() * 60;
        try {
          await this._hamsterProxy!.call(
            "StopTracking",
            new GLib.Variant("(i)", [endTime]),
            Gio.DBusCallFlags.NONE,
            -1,
            null
          );
        } catch (e) {
          logger.log(`error: ${e}`);
        }
      }
    );
    this._settings = this.getSettings();
    this._sessionSettings = this.getSettings("org.gnome.desktop.session");
    this._useSessionIdleDelayHandlerId = this._settings.connect(
      "changed::use-session-idle-delay",
      (settings: Gio.Settings, key: string): void => {
        const useSessionIdleDelay = settings.get_boolean(key);
        this.updateSessionIdleSync(useSessionIdleDelay);
      }
    );
    const useSessionIdleDelay = this._settings.get_boolean(
      "use-session-idle-delay"
    );
    this.updateSessionIdleSync(useSessionIdleDelay);
    this._settings.connect(
      "changed::idle-delay",
      async (settings: Gio.Settings, key: string): Promise<void> => {
        const idleDelaySec = settings.get_value(key).get_uint16();
        await this.updateIdleWatch(idleDelaySec);
      }
    );
    const idleDelaySec = this._settings.get_value("idle-delay").get_uint16();
    await this.updateIdleWatch(idleDelaySec);
  }

  async disable(): Promise<void> {
    const logger = this.getLogger();
    logger.log("idle hamster disable");
    await this.removeIdleWatch();
    if (this._sessionIdleDelayHandlerId != undefined) {
      this._sessionSettings!.disconnect(this._sessionIdleDelayHandlerId);
      this._sessionIdleDelayHandlerId = undefined;
    }
    this._sessionSettings = undefined;
    if (this._useSessionIdleDelayHandlerId != undefined) {
      this._settings!.disconnect(this._useSessionIdleDelayHandlerId);
      this._useSessionIdleDelayHandlerId = undefined;
    }
    if (this._idleDelayHandlerId != undefined) {
      this._settings!.disconnect(this._idleDelayHandlerId);
      this._idleDelayHandlerId = undefined;
    }
    this._settings = undefined;
    if (this._watchFiredHandlerId != undefined) {
      this._idleMonitorProxy!.disconnect(this._watchFiredHandlerId);
      this._watchFiredHandlerId = undefined;
    }
    this._idleMonitorProxy = undefined;
    this._hamsterProxy = undefined;
  }

  async removeIdleWatch(): Promise<void> {
    if (this._watchId != undefined) {
      await this._idleMonitorProxy!.call(
        "RemoveWatch",
        new GLib.Variant("(u)", [this._watchId]),
        Gio.DBusCallFlags.NONE,
        -1,
        null
      );
      this._watchId = undefined;
    }
  }

  updateSessionIdleDelay(idleDelaySec: number): void {
    if (idleDelaySec == 0) {
      // Idle delay of 0 means it's been disabled
      // so disable the sync ourselves
      this.updateSessionIdleSync(false);
    } else {
      this._settings!.set_value(
        "idle-delay",
        GLib.Variant.new_uint16(idleDelaySec + IDLE_DELAY_OFFSET_SEC)
      );
    }
  }

  updateSessionIdleSync(useSessionIdleDelay: boolean): void {
    if (useSessionIdleDelay && this._sessionIdleDelayHandlerId == undefined) {
      this._sessionIdleDelayHandlerId = this._sessionSettings!.connect(
        "changed::idle-delay",
        (settings: Gio.Settings, key: string): void => {
          const idleDelaySec = settings.get_uint(key);
          this.updateSessionIdleDelay(idleDelaySec);
        }
      );
      const idleDelaySec = this._sessionSettings!.get_uint("idle-delay");
      this.updateSessionIdleDelay(idleDelaySec);
    } else if (
      !useSessionIdleDelay &&
      this._sessionIdleDelayHandlerId != undefined
    ) {
      this._sessionSettings!.disconnect(this._sessionIdleDelayHandlerId);
      this._useSessionIdleDelayHandlerId = undefined;
    }
  }

  async updateIdleWatch(idleTimeSec: number): Promise<void> {
    const logger = this.getLogger();
    logger.log(`Add idle watch for ${toTimeString(idleTimeSec)}`);
    await this.removeIdleWatch();
    const idleTimeMs = idleTimeSec * 1000;
    const watchId = (
      await this._idleMonitorProxy!.call(
        "AddIdleWatch",
        new GLib.Variant("(t)", [idleTimeMs]),
        Gio.DBusCallFlags.NONE,
        -1,
        null
      )
    )
      .get_child_value(0)
      .get_uint32();
    logger.log(`watch ID: ${watchId}`);
    this._watchId = watchId;
  }
}
