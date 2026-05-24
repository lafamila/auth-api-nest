import { AccountStatus } from '../../../database/entities/account.entity';
import { AccountServicePermissionStatus } from '../../../database/entities/account-service-permission.entity';
import { PermissionStatus } from '../../../database/entities/service-permission-definition.entity';
import { ServiceStatus } from '../../../database/entities/service.entity';

export interface PermissionDashboardRowDto {
  id: string;
  accountId: string;
  loginId: string;
  accountName: string;
  email: string;
  accountStatus: AccountStatus;
  isSuperAdmin: boolean;
  serviceId: string;
  serviceKey: string;
  serviceName: string;
  serviceStatus: ServiceStatus;
  permissionDefinitionId: string;
  permissionKey: string;
  permissionLabel: string;
  permissionStatus: PermissionStatus;
  assignmentStatus: AccountServicePermissionStatus;
  grantedAt: Date;
  revokedAt: Date | null;
  grantedByAccountId: string | null;
}
