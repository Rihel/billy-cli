import 'dotenv/config';
import { Effect } from 'effect';
import { program } from './app.js';

void Effect.runPromise(program);
