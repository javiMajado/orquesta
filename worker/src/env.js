import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { snapshotShellEnv } from '@orquesta/shared/env';

snapshotShellEnv();
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
