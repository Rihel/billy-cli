import 'dotenv/config';
import { configureLogger } from '@repo/core';
configureLogger(true);
import { program } from './app.js';

void program();
