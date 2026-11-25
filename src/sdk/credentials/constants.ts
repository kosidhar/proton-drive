import { APP_ID } from '../../linux/appId';

export const CREDENTIALS_SERVICE = `${APP_ID}/drive-sdk-cli`;
export const CREDENTIALS_NAME = 'auth-session';
export const PASS_CREDENTIALS_PATH = `${CREDENTIALS_SERVICE}/${CREDENTIALS_NAME}`;
