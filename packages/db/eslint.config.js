import base from "@ssos/config/eslint";

export default [
  ...base,
  {
    files: ["seed/**/*.ts", "rls/**/*.ts"],
    rules: { "no-console": "off" },
  },
];
