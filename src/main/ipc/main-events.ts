import { EventEmitter } from 'events';

class MainEventEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(20);
  }
}

export const mainEventEmitter = new MainEventEmitter();

export const MAIN_EVENTS = {
  CONFIG_CHANGED: 'config:changed',
  PROXY_STARTED: 'proxy:started',
  PROXY_STOPPED: 'proxy:stopped',
} as const;
