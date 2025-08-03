// Wraps `gettext` to add support for template strings
export function templateTagWrapper(
  gettext: (msg: string) => string
): (
  stringsArrayOrStrings: TemplateStringsArray | string,
  ...exprs: any[]
) => string {
  return function (
    stringsArrayOrString: TemplateStringsArray | string,
    ...exprs: any[]
  ): string {
    const msgId =
      typeof stringsArrayOrString == "string"
        ? stringsArrayOrString
        : stringsArrayOrString
            .flatMap((str, i) => [str, i < exprs.length ? `{${i}}` : ""])
            .join("");
    let translated = gettext(msgId) as string;
    for (let [i, expr] of exprs.entries()) {
      translated = translated.replace(`{${i}}`, `${expr}`);
    }
    return translated;
  };
}
