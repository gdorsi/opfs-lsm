// Repository rules for oxlint, loaded through `jsPlugins` in .oxlintrc.json.

const DECODERS = new Set(["TextDecoder", "TextDecoderStream"]);

/** True when `options` is an object literal that sets `ignoreBOM: true`. */
function setsIgnoreBom(options) {
  if (options?.type !== "ObjectExpression") return false;
  return options.properties.some(
    (p) =>
      p.type === "Property" &&
      !p.computed &&
      (p.key.name ?? p.key.value) === "ignoreBOM" &&
      p.value.type === "Literal" &&
      p.value.value === true,
  );
}

export default {
  meta: { name: "opfs-lsm" },
  rules: {
    "text-decoder-ignore-bom": {
      meta: { type: "problem" },
      create(context) {
        return {
          NewExpression(node) {
            if (node.callee.type !== "Identifier" || !DECODERS.has(node.callee.name)) return;
            if (setsIgnoreBom(node.arguments[1])) return;
            context.report({
              node,
              message:
                `${node.callee.name} drops a leading U+FEFF unless told otherwise, so a stored string that starts with one reads back changed. Pass ("utf-8", { ignoreBOM: true }).`,
            });
          },
        };
      },
    },
  },
};
