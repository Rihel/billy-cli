import { makeRuntimeLayer } from '@repo/core';
import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
} from 'effect';
import { AppConfig } from './app-config.js';
import { RequestContext, RequestContextStorage } from './request-context.js';

type CoreRuntimeServices = Layer.Layer.Success<
  ReturnType<typeof makeRuntimeLayer>
>;

export interface EffectExecutorApi {
  run<A, E, R extends CoreRuntimeServices | RequestContext>(
    effect: Effect.Effect<A, E, R>,
  ): Promise<A>;
}

export class EffectExecutor extends Context.Tag('app/EffectExecutor')<
  EffectExecutor,
  EffectExecutorApi
>() {}

export const EffectExecutorLive = Layer.scoped(
  EffectExecutor,
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const requestStorage = yield* RequestContextStorage;
    const runtime = ManagedRuntime.make(makeRuntimeLayer(config.core));
    yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()));

    return {
      async run(effect) {
        const providedEffect = Effect.provideService(effect, RequestContext, {
          userId: requestStorage.get('userId') ?? null,
        });
        const exit = await runtime.runPromiseExit(
          providedEffect as Effect.Effect<
            unknown,
            unknown,
            CoreRuntimeServices
          >,
        );
        if (Exit.isSuccess(exit)) return exit.value as never;

        const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
        if (failure !== undefined) throw failure;
        throw new Error(Cause.pretty(exit.cause));
      },
    };
  }),
);
