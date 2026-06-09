import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  email?: string;
  password?: string;
  community?: string;
  player?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
