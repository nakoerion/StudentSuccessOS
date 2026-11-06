import base from "@ssos/config/eslint";

export default [
  ...base,
  {
    files: ["src/worker.ts"],
    rules: { "no-console": "off" },
  },
];
