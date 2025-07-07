import { ConsoleLike } from "@girs/gnome-shell/extensions/extension";
import Gio from "gi://Gio";
import GLib from "gi://GLib";

export interface Connection {
  disconnect(): Promise<void>;
}

export interface Connector {
  id: string;
  connect(): Promise<Connection>;
}

export function forSettingsKeyChange<T>(
  logger: ConsoleLike,
  settings: Gio.Settings,
  key: string,
  callback: (value: T) => Promise<void>
): Connector {
  return {
    id: `${settings.schemaId}.${key}::changed`,
    async connect(): Promise<Connection> {
      const handlerId = settings.connect(
        `changed::${key}`,
        async (settings: Gio.Settings, key: string): Promise<void> => {
          const value: T = settings.get_value(key).recursiveUnpack();
          logger.info(`changed ${settings.schema_id}.${key}=${value}`);
          await callback(value);
        }
      );
      logger.debug(
        `connected to changes of ${settings.schemaId}.${key} with handler ID ${handlerId}`
      );
      // Need to always access a key after connecting for changes
      await callback(settings!.get_value(key).recursiveUnpack());
      return {
        async disconnect(): Promise<void> {
          settings.disconnect(handlerId);
          logger.debug(
            `disconnected from changes to ${settings.schemaId}.${key} with handler ID ${handlerId}`
          );
        },
      };
    },
  };
}

export function forProxySignal<T>(
  logger: ConsoleLike,
  proxy: Gio.DBusProxy,
  signal: string,
  callback: (value: T) => Promise<void>
): Connector {
  return {
    id: `${proxy.get_object_path()}/g-signal::${signal}`,
    async connect(): Promise<Connection> {
      const handlerId = proxy.connect(
        `g-signal::${signal}`,
        async (
          source: Gio.DBusProxy,
          _senderName: string | null,
          signalName: string,
          parameters: GLib.Variant
        ) => {
          const value = parameters.recursiveUnpack();
          logger.info(
            `received signal ${signalName}=${value} from ${source.get_interface_name()}`
          );
          await callback(value);
        }
      );
      logger.debug(
        `connected to signal '${signal}' of ${proxy.get_interface_name()} with handler ID ${handlerId}`
      );
      return {
        async disconnect(): Promise<void> {
          proxy.disconnect(handlerId);
          logger.debug(
            `disconnected from signal '${signal}' of ${proxy.get_interface_name()} with handler ID ${handlerId}`
          );
        },
      };
    },
  };
}

export function forProxyCall(
  logger: ConsoleLike,
  proxy: Gio.DBusProxy,
  subscribe: string,
  unsubscribe: string,
  args: GLib.Variant
): Connector {
  const interfaceName = proxy.get_interface_name();
  return {
    id: `${interfaceName}.${subscribe}}()`,
    async connect(): Promise<Connection> {
      const handlerId = await proxy.call(
        subscribe,
        args,
        Gio.DBusCallFlags.NONE,
        -1,
        null
      );
      const handlerIdStr = handlerId.print(false);
      logger.debug(
        `${interfaceName}.${subscribe}(${args.print(false)}) -> ${handlerIdStr}`
      );
      return {
        async disconnect(): Promise<void> {
          await proxy.call(
            unsubscribe,
            handlerId,
            Gio.DBusCallFlags.NONE,
            -1,
            null
          );
          logger.debug(`${interfaceName}.${unsubscribe}(${handlerIdStr})`);
        },
      };
    },
  };
}
