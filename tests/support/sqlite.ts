/** Feature detection covers Node releases that lack node:sqlite or require a flag. */
export const sqliteAvailable = await import('node:sqlite').then(() => true, () => false);
