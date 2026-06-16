export const VISITOR_PERMISSION = {
  key: 'visitor',
  label: '방문자',
  description: '서비스 신청이 필요함',
} as const;

export const SUPERADMIN_PERMISSION = {
  key: 'superadmin',
  label: 'Super Admin',
  description: 'Auth superadmin account with full service access',
  sortOrder: -2000,
} as const;
