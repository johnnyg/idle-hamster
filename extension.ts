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
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as MessageTray from "resource:///org/gnome/shell/ui/messageTray.js";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Signal from "./signals.js";
import { gettext as _ } from "./gettext.js";

import * as Hamster from "hamster";

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

type StopTrackingReason = "idleness" | "screen lock" | "suspend" | "shutdown";
type StopOnSuspendChoices = "never" | "idle" | "always";

function toTimeString(millisec: number): string {
  const sec = millisec / 1000;
  return `${Math.floor(sec / 60)} min ${Math.floor(sec % 60)} sec`;
}

function isTrackingActivity(fact?: Hamster.Fact): boolean {
  return fact?.range.end === null;
}

export default class IdleHamsterExtension extends Extension {
  _hamsterProxy?: Gio.DBusProxy;
  _idleMonitorProxy?: Gio.DBusProxy;
  _screensaverProxy?: Gio.DBusProxy;
  _loginManagerProxy?: Gio.DBusProxy;
  _settings?: Gio.Settings;
  _signals?: Map<Signal.ID, Signal.Connection>;
  _trackingActivityOnlySignals?: Set<Signal.ID>;
  _todaysLastFact?: Hamster.Fact;
  _notificationSource?: MessageTray.Source;
  _notifyOnStop?: boolean;
  _suspendTime?: Date;

  async enable(): Promise<void> {
    const logger = this.getLogger();
    logger.debug("enabled");
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
    let hamsterVersion: string | undefined = undefined;
    try {
      hamsterVersion = (
        await this._hamsterProxy!.call(
          "Version",
          null,
          Gio.DBusCallFlags.NONE,
          -1,
          null
        )
      ).recursiveUnpack();
    } catch (err) {
      if (
        err instanceof Gio.DBusError &&
        err.code == Gio.DBusError.SERVICE_UNKNOWN
      ) {
        const source = this.getNotificationSource();
        const notification = new MessageTray.Notification({
          source: source,
          title: _("Idle hamster error"),
          body: _("Couldn't enable extension; please install hamster"),
          gicon: new Gio.ThemedIcon({ name: "dialog-error" }),
          iconName: "dialog-error",
          urgency: MessageTray.Urgency.HIGH,
        });
        notification.addAction(_("Open hamster website"), (): void => {
          Gio.AppInfo.launch_default_for_uri(
            "https://github.com/projecthamster/hamster",
            null
          );
        });
        source.addNotification(notification);
        err = new Error(
          _("Unable to detect hamster, please make sure it is installed"),
          {
            cause: err,
          }
        );
      }
      throw err;
    }
    logger.info(`detected hamster version ${hamsterVersion}`);
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
    this._screensaverProxy = await (
      Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
    )(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      "org.gnome.ScreenSaver",
      "/org/gnome/ScreenSaver",
      "org.gnome.ScreenSaver",
      null
    );
    this._loginManagerProxy = await (
      Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
    )(
      Gio.BusType.SYSTEM,
      Gio.DBusProxyFlags.NONE,
      null,
      "org.freedesktop.login1",
      "/org/freedesktop/login1",
      "org.freedesktop.login1.Manager",
      null
    );
    this._settings = this.getSettings();
    await this.addSignals(
      Signal.forProxySignal(
        logger,
        this._hamsterProxy,
        "FactsChanged",
        this.checkIfTrackingActivity.bind(this)
      ),
      Signal.forSettingsKeyChange(
        logger,
        this._settings,
        "use-session-idle-delay",
        this.updateSessionIdleSync.bind(this)
      )
    );
    await this.checkIfTrackingActivity();
  }

  async disable(): Promise<void> {
    const logger = this.getLogger();
    this._todaysLastFact = undefined;
    for (let [_signalId, signal] of this._signals ?? []) {
      await signal?.disconnect();
    }
    this._signals?.clear();
    this._trackingActivityOnlySignals?.clear();
    this._settings = undefined;
    this._idleMonitorProxy = undefined;
    this._screensaverProxy = undefined;
    this._loginManagerProxy = undefined;
    this._hamsterProxy = undefined;
    this._notificationSource = undefined;
    this._notifyOnStop = undefined;
    this._suspendTime = undefined;
    logger.debug("disabled");
  }

  getNotificationSource() {
    if (this._notificationSource === undefined) {
      const notificationPolicy = new MessageTray.NotificationGenericPolicy();
      this._notificationSource = new MessageTray.Source({
        title: _("Idle Hamster"),
        icon: new Gio.ThemedIcon({ name: "dialog-information" }),
        iconName: "dialog-information",
        policy: notificationPolicy,
      });

      // Reset the notification source if it's destroyed
      this._notificationSource.connect("destroy", (_source) => {
        this._notificationSource = undefined;
      });
      Main.messageTray.add(this._notificationSource);
    }
    return this._notificationSource;
  }

  async addSignals(...signals: Signal.Connector[]): Promise<Set<Signal.ID>> {
    if (this._signals === undefined) {
      this._signals = new Map();
    }
    const addedSignalIDs = new Set<Signal.ID>();
    for (let signal of signals) {
      await this._signals?.get(signal.id)?.disconnect();
      this._signals.set(signal.id, await signal.connect());
      addedSignalIDs.add(signal.id);
    }
    return addedSignalIDs;
  }

  async removeSignals(...signals: Signal.Connector[]): Promise<void> {
    for (let signal of signals) {
      await this._signals?.get(signal.id)?.disconnect();
      this._signals?.delete(signal.id);
    }
  }

  updateTrackingActivityOnlySignals(signalIDs: Set<Signal.ID>): void {
    this._trackingActivityOnlySignals = new Set([
      ...(this._trackingActivityOnlySignals ?? []),
      ...signalIDs,
    ]);
  }

  async removeTrackingActivityOnlySignals(): Promise<void> {
    for (let signalID of this._trackingActivityOnlySignals ?? []) {
      await this._signals?.get(signalID)?.disconnect();
      this._signals?.delete(signalID);
    }
    this._trackingActivityOnlySignals?.clear();
  }

  async getTodaysLastFact(): Promise<Hamster.Fact | undefined> {
    const logger = this.getLogger();
    let lastFact: Hamster.Fact | undefined = undefined;
    try {
      const [factsJSON]: string[][] = (
        await this._hamsterProxy!.call(
          "GetTodaysFactsJSON",
          null,
          Gio.DBusCallFlags.NONE,
          -1,
          null
        )
      ).recursiveUnpack();
      const lastFactJSON = factsJSON?.at(-1);
      logger.debug(`today's last fact JSON: '${lastFactJSON}'`);
      if (lastFactJSON) {
        lastFact = JSON.parse(lastFactJSON) as Hamster.Fact;
      }
    } catch (e) {
      logger.error(`error getting today's facts: ${e}`);
    }
    return lastFact;
  }

  async checkIfTrackingActivity(): Promise<void> {
    const logger = this.getLogger();
    const wasTracking = isTrackingActivity(this._todaysLastFact);
    this._todaysLastFact = await this.getTodaysLastFact();
    const isTracking = isTrackingActivity(this._todaysLastFact);
    if (!wasTracking && isTracking) {
      this.updateTrackingActivityOnlySignals(
        await this.addSignals(
          Signal.forProxySignal(
            logger,
            this._idleMonitorProxy!,
            "WatchFired",
            this.stopTracking.bind(this, "idleness")
          ),
          Signal.forSettingsKeyChange(
            logger,
            this._settings!,
            "idle-delay",
            this.updateIdleWatchSignal.bind(this)
          ),
          Signal.forSettingsKeyChange(
            logger,
            this._settings!,
            "stop-on-lock",
            this.updateStopOnLock.bind(this)
          ),
          Signal.forSettingsKeyChange(
            logger,
            this._settings!,
            "stop-on-suspend",
            this.updateStopOnSuspend.bind(this)
          ),
          Signal.forSettingsKeyChange(
            logger,
            this._settings!,
            "stop-on-shutdown",
            this.updateStopOnShutdown.bind(this)
          ),
          Signal.forSettingsKeyChange(
            logger,
            this._settings!,
            "notify-on-stop",
            this.updateNotifyOnStop.bind(this)
          )
        )
      );
    } else if (wasTracking && !isTracking) {
      await this.removeTrackingActivityOnlySignals();
    }
  }

  async stopTracking(
    reason: StopTrackingReason,
    lastActiveTime?: Date
  ): Promise<void> {
    const logger = this.getLogger();
    let idleTime: number;
    if (lastActiveTime === undefined) {
      [idleTime] = (
        await this._idleMonitorProxy!.call(
          "GetIdletime",
          null,
          Gio.DBusCallFlags.NONE,
          -1,
          null
        )
      ).recursiveUnpack() as [number];
      lastActiveTime = new Date(Date.now() - idleTime);
    } else {
      idleTime = Date.now() - lastActiveTime.getTime();
    }
    const lastActiveTimeMillis = lastActiveTime.getTime();
    const lastActiveTimeSecs = Math.floor(lastActiveTimeMillis / 1000);
    const lastActiveTimeString = new Date(
      lastActiveTimeMillis
    ).toLocaleTimeString();
    const activity = this._todaysLastFact!.activity;
    let stopMsg = `stopping hamster activity tracking of '${activity}' due to ${reason}`;
    if (reason == "idleness") {
      logger.info(`idle time: ${toTimeString(idleTime)}`);
      stopMsg += `; user last active at ${lastActiveTimeString}`;
    }
    logger.log(stopMsg);
    // Workaround for https://github.com/projecthamster/hamster/issues/775
    const endTime = lastActiveTimeSecs - new Date().getTimezoneOffset() * 60;
    try {
      await this._hamsterProxy!.call(
        "StopTracking",
        new GLib.Variant("(i)", [endTime]),
        Gio.DBusCallFlags.NONE,
        -1,
        null
      );
    } catch (e) {
      logger.error(`failed to stop tracking hamster activity: ${e}`);
    }
    if (this._notifyOnStop) {
      const source = this.getNotificationSource();
      let msg: string;
      // Don't just subsitute `reason` because we want to translate the entire phrase
      switch (reason) {
        case "idleness":
          msg = _`end time was set to ${lastActiveTimeString} due to idleness`;
          break;
        case "screen lock":
          msg = _`end time was set to ${lastActiveTimeString} due to the screen being locked`;
          break;
        case "suspend":
          msg = _`end time was set to ${lastActiveTimeString} due to the computer being suspended`;
          break;
        case "shutdown":
          msg = _`end time was set to ${lastActiveTimeString} due to the computer being shutdown`;
          break;
      }
      const notification = new MessageTray.Notification({
        source: source,
        title: _`Stopped tracking activity '${activity}'`,
        body: msg,
        gicon: new Gio.ThemedIcon({ name: "dialog-information" }),
        iconName: "dialog-information",
        urgency: MessageTray.Urgency.NORMAL,
      });
      notification.addAction(_("open preferences"), (): void => {
        this.openPreferences();
      });
      notification.addAction(
        _("resume tracking activity"),
        async (): Promise<void> => {
          try {
            await this._hamsterProxy!.call(
              "StopOrRestartTracking",
              null,
              Gio.DBusCallFlags.NONE,
              -1,
              null
            );
          } catch (e) {
            logger.error(`failed to resume tracking hamster activity: ${e}`);
          }
        }
      );
      source.addNotification(notification);
    }
  }

  async updateSessionIdleDelay(idleDelaySec: number): Promise<void> {
    if (idleDelaySec == 0) {
      // Idle delay of 0 means it's been disabled
      // so disable the sync ourselves
      this._settings!.set_value(
        "use-session-idle-delay",
        GLib.Variant.new_boolean(false)
      );
    } else {
      this._settings!.set_value(
        "idle-delay",
        GLib.Variant.new_uint16(idleDelaySec + IDLE_DELAY_OFFSET_SEC)
      );
    }
  }

  async updateSessionIdleSync(useSessionIdleDelay: boolean): Promise<void> {
    const signal = Signal.forSettingsKeyChange(
      this.getLogger(),
      this.getSettings("org.gnome.desktop.session"),
      "idle-delay",
      this.updateSessionIdleDelay.bind(this)
    );
    if (useSessionIdleDelay) {
      await this.addSignals(signal);
    } else {
      await this.removeSignals(signal);
    }
  }

  async updateIdleWatchSignal(idleTimeSec: number): Promise<void> {
    this.updateTrackingActivityOnlySignals(
      await this.addSignals(
        Signal.forProxyCall(
          this.getLogger(),
          this._idleMonitorProxy!,
          "AddIdleWatch",
          "RemoveWatch",
          new GLib.Variant("(t)", [idleTimeSec * 1000])
        )
      )
    );
  }

  async updateStopOnLock(stopOnLock: boolean): Promise<void> {
    const signal = Signal.forProxySignal(
      this.getLogger(),
      this._screensaverProxy!,
      "ActiveChanged",
      async (active: boolean): Promise<void> => {
        if (active) {
          await this.stopTracking("screen lock");
        }
      }
    );
    if (stopOnLock) {
      this.updateTrackingActivityOnlySignals(await this.addSignals(signal));
    } else {
      await this.removeSignals(signal);
    }
  }

  async updateStopOnSuspend(
    stopOnSuspend: StopOnSuspendChoices
  ): Promise<void> {
    const logger = this.getLogger();
    const signal = Signal.forProxySignal(
      logger,
      this._loginManagerProxy!,
      "PrepareForSleep",
      async (start: boolean): Promise<void> => {
        if (stopOnSuspend == "always" && start) {
          await this.stopTracking("suspend");
        } else if (stopOnSuspend == "idle") {
          if (start) {
            const now = new Date();
            logger.debug(`setting sleep time to ${now}`);
            this._suspendTime = now;
          } else {
            logger.debug(`suspend time was ${this._suspendTime}`);
            if (this._suspendTime) {
              const suspendDuration = Date.now() - this._suspendTime.getTime();
              logger.debug(
                `was suspended for ${toTimeString(suspendDuration)}`
              );
              const idleDuration =
                this._settings!.get_value("idle-delay").recursiveUnpack() *
                1000;
              if (suspendDuration >= idleDuration) {
                await this.stopTracking("idleness", this._suspendTime);
              }
              this._suspendTime = undefined;
            }
          }
        }
      }
    );
    if (stopOnSuspend != "never") {
      this.updateTrackingActivityOnlySignals(await this.addSignals(signal));
    } else {
      await this.removeSignals(signal);
    }
  }

  async updateStopOnShutdown(stopOnShutdown: boolean): Promise<void> {
    const signal = Signal.forProxySignal(
      this.getLogger(),
      this._loginManagerProxy!,
      "PrepareForShutdown",
      async (start: boolean): Promise<void> => {
        if (start) {
          await this.stopTracking("shutdown");
        }
      }
    );
    if (stopOnShutdown) {
      this.updateTrackingActivityOnlySignals(await this.addSignals(signal));
    } else {
      await this.removeSignals(signal);
    }
  }

  async updateNotifyOnStop(notifyOnStop: boolean): Promise<void> {
    const logger = this.getLogger();
    logger.debug(
      `show notifications on stopping activity tracking? ${notifyOnStop}`
    );
    this._notifyOnStop = notifyOnStop;
  }
}
