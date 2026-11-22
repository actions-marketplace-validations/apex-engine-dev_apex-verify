import * as store from "./store.js";

// command name -> store function name
export const COMMANDS = {
  get: "loadItem",
  count: "itemCount",
};

export function run(cmd, ...args) {
  const fn = store[COMMANDS[cmd]];
  if (!fn) throw new Error("unknown command " + cmd);
  return fn(...args);
}
