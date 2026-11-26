import pkg from '../package.json';

/** The app's version: package.json's `version`, bundled into the compiled binary at build time. */
export const APP_PACKAGE_VERSION: string = pkg.version;
