export const Pages = {
  login: '/auth/login',
  register: '/auth/register',
  forgotPassword: '/auth/forgot-password',
  resetPassword: '/auth/reset-password',
  home: '/',
}

export const TokenKey = 'access-token'
export const AppName = 'Billy CLI'
export const ServerUrl =
  process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:9989'
