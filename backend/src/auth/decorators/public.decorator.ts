import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Mark an endpoint as not requiring JWT (login / register / refresh, etc.). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
