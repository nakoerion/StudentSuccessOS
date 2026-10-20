import base from "@ssos/config/eslint";

export default [
  ...base,
  {
    files: ["seed/**/*.ts", "rls/**/*.ts", "scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
];
