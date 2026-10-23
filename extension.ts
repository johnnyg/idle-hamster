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

import {
  Extension,
  gettext,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as Signal from "./signals.js";
import { templateTagWrapper } from "./utils.js";

import * as Hamster from "hamster";

Gio._promisify(Gio.DBusProxy, "new_for_bus");
Gio._promisify(Gio.DBusProxy.prototype, "call");

const IDLE_DELAY_OFFSET_SEC = 12; // 10s to blank
const _ = templateTagWrapper(gettext);

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

type SessionOverReason = "shutdown" | "reboot" | "logout";
type StopTrackingReason = "idleness" | "screen lock" | "suspend" | SessionOverReason;
type StopOnSuspendChoices = "never" | "idle" | "always";

type ShutdownType = "poweroff" | "reboot" | "halt" | "kexec" | "soft-reboot";
interface PrepareForShutdownMetadata {
  type: ShutdownType;
}

function toTimeString(millisec: number): string {
  const sec = millisec / 1000;
  return `${Math.floor(sec / 60)} min ${Math.floor(sec % 60)} sec`;
}

export default class IdleHamsterExtension extends Extension {
  _hamsterProxy?: Gio.DBusProxy;
  _hamsterGUIGtkActionsProxy?: Gio.DBusProxy;
  _idleMonitorProxy?: Gio.DBusProxy;
  _screensaverProxy?: Gio.DBusProxy;
  _loginManagerProxy?: Gio.DBusProxy;
  _sessionManagerProxy?: Gio.DBusProxy;
  _settings?: Gio.Settings;
  _signals?: Map<Signal.ID, Signal.Connection>;
  _trackingActivityOnlySignals?: Set<Signal.ID>;
  _todaysLastFact?: Hamster.Fact;
  _notificationSource?: MessageTray.Source;
  _notifyOnStop?: boolean;
  _sessionOverReason?: SessionOverReason;
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
    this._hamsterGUIGtkActionsProxy = await (
      Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
    )(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION,
      null,
      "org.gnome.Hamster.GUI",
      "/org/gnome/Hamster/GUI",
      "org.gtk.Actions",
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
    this._sessionManagerProxy = await (
      Gio.DBusProxy.new_for_bus as GioDBusProxyNewForBus
    )(
      Gio.BusType.SESSION,
      Gio.DBusProxyFlags.NONE,
      null,
      "org.gnome.SessionManager",
      "/org/gnome/SessionManager",
      "org.gnome.SessionManager",
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

  // Extension requires unlock-dialog mode so that we can receive
  // the follow signals even if the screen is locked:
  //  - idle monitor's watch fired signal
  //  - screensaver's active changed signal
  disable(): void {
    const logger = this.getLogger();
    this._todaysLastFact = undefined;
    for (let [_signalId, signal] of this._signals ?? []) {
      // we can't await on this anymore
      // so let's just hope it finishes in time
      signal?.disconnect();
    }
    this._signals?.clear();
    this._trackingActivityOnlySignals?.clear();
    this._settings = undefined;
    this._idleMonitorProxy = undefined;
    this._screensaverProxy = undefined;
    this._loginManagerProxy = undefined;
    this._sessionManagerProxy = undefined;
    this._hamsterGUIGtkActionsProxy = undefined;
    this._hamsterProxy = undefined;
    this._notificationSource = undefined;
    this._notifyOnStop = undefined;
    this._sessionOverReason = undefined;
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

  isTrackingActivity(): boolean {
    return this._todaysLastFact?.range.end === null;
  }

  async checkIfTrackingActivity(): Promise<void> {
    const logger = this.getLogger();
    const wasTracking = this.isTrackingActivity();
    this._todaysLastFact = await this.getTodaysLastFact();
    const isTracking = this.isTrackingActivity();
    if (!wasTracking && isTracking) {
      this.updateTrackingActivityOnlySignals(
        await this.addSignals(
          Signal.forProxySignal(
            logger,
            this._idleMonitorProxy!,
            "WatchFired",
            this.stopTracking.bind(this, "idleness", undefined)
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
            this.updateStopOnSessionOver.bind(this, "shutdown")
          ),
          Signal.forSettingsKeyChange(
            logger,
            this._settings!,
            "stop-on-reboot",
            this.updateStopOnSessionOver.bind(this, "reboot")
          ),
          Signal.forSettingsKeyChange(
            logger,
            this._settings!,
            "stop-on-logout",
            this.updateStopOnSessionOver.bind(this, "logout")
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
      // Don't just substitute `reason` because we want to translate the entire phrase
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
        case "reboot":
          msg = _`end time was set to ${lastActiveTimeString} due to the computer being restarted`;
          break;
        case "logout":
          msg = _`end time was set to ${lastActiveTimeString} due to the user logging out`;
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
      notification.addAction(
        _("open hamster overview"),
        async (): Promise<void> => {
          await this._hamsterGUIGtkActionsProxy!.call(
            "Activate",
            new GLib.Variant("(sava{sv})", ["overview", [], {}]),
            Gio.DBusCallFlags.NONE,
            -1,
            null
          );
        }
      );
      notification.addAction(
        _("open preferences"),
        this.openPreferences.bind(this)
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

  async updateStopOnSessionOver(stopOnSessionOverReason: SessionOverReason, enabled: boolean): Promise<void> {
    const logger = this.getLogger();
    const prepareForShutdownSignal = Signal.forProxySignal(
      logger,
      this._loginManagerProxy!,
      "PrepareForShutdownWithMetadata",
      async (start: boolean, metadata: PrepareForShutdownMetadata): Promise<void> => {
        if (start) {
          logger.debug(`shutdown type: ${metadata.type}`);
          let processNow = false;
          let sessionOverReason: SessionOverReason;
          switch (metadata.type) {
            case "poweroff":
            case "halt":
              sessionOverReason = "shutdown";
              break;
            case "soft-reboot":
            case "kexec":
              // for some reason these types of soft reboots don't emit a SessionOver event
              // so in order to avoid code duplication let's just manually call the handler now
              processNow = true;
            case "reboot":
              sessionOverReason = "reboot";
              break;
          }
          logger.debug(`setting session over season to ${sessionOverReason}`);
          this._sessionOverReason = sessionOverReason;
          if (processNow) {
            await this.onSessionOver();
          }
        }
      }
    );
    const sessionOverSignal = Signal.forProxySignal(
        logger,
        this._sessionManagerProxy!,
        "SessionOver",
        this.onSessionOver.bind(this)
    );
    if (stopOnShutdown) {
      this.updateTrackingActivityOnlySignals(await this.addSignals(prepareForShutdownSignal, sessionOverSignal));
    } else {
      await this.removeSignals(prepareForShutdownSignal, sessionOverSignal);
    }
  }

  async onSessionOver(): Promise<void> {
    const logger = this.getLogger();
    const sessionOverReason: SessionOverReason = this._sessionOverReason ?? "logout";
    this._sessionOverReason = undefined;
    logger.debug(`session over: reason? ${sessionOverReason}`);
    const enabled = this._settings!.get_boolean(`stop-on-${sessionOverReason}`);
    logger.debug(`stop on ${sessionOverReason}? ${enabled}`);
    if (enabled) {
      await this.stopTracking(sessionOverReason);
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
