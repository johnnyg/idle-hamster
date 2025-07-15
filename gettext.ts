import { gettext as _gettext } from "gettext";

export function gettext(strings: string): string;
export function gettext(strings: TemplateStringsArray, ...exprs: any[]): string;
export function gettext(
  stringsArrayOrString: TemplateStringsArray | string,
  ...exprs: any[]
): string {
  const msgId =
    typeof stringsArrayOrString == "string"
      ? stringsArrayOrString
      : stringsArrayOrString
          .flatMap((str, i) => [str, i < exprs.length ? `{${i}}` : ""])
          .join("");
  let translated = _gettext(msgId) as string;
  for (let [i, expr] of exprs.entries()) {
    translated = translated.replace(`{${i}}`, `${expr}`);
  }
  return translated;
}
