import { join } from 'path';

export const DOC_FILE = join(process.cwd(), 'document.atomz');
export const RENDER_DOC_FILE = join(process.cwd(), '.atomz-render.json');
export const HISTORY_FILE = join(process.cwd(), '.atomz-history.json');
export const STATE_FILE = join(process.cwd(), '.atomz-state.json');
export const OPS_FILE = join(process.cwd(), '.atomz-ops.jsonl');
