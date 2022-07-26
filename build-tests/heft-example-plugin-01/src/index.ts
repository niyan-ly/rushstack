import { SyncHook } from 'tapable';
import type {
  IHeftTaskPlugin,
  IHeftTaskSession,
  HeftConfiguration,
  IHeftTaskRunHookOptions
} from '@rushstack/heft';

export interface IExamplePlugin01Accessor {
  exampleHook: SyncHook;
}

export const PLUGIN_NAME: 'ExamplePlugin01' = 'ExamplePlugin01';

export default class ExamplePlugin01 implements IHeftTaskPlugin {
  private _accessor: IExamplePlugin01Accessor = {
    exampleHook: new SyncHook()
  };

  public get accessor(): IExamplePlugin01Accessor {
    return this._accessor;
  }

  public apply(taskSession: IHeftTaskSession, heftConfiguration: HeftConfiguration): void {
    taskSession.hooks.run.tapPromise(PLUGIN_NAME, async (build: IHeftTaskRunHookOptions) => {
      this.accessor.exampleHook.call();
    });
  }
}
