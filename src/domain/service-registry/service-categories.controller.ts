import { Controller, Get } from '@nestjs/common';
import { SERVICE_CATEGORIES } from '../../database/entities/service.entity';

@Controller('api/service-categories')
export class ServiceCategoriesController {
  @Get()
  list() {
    return SERVICE_CATEGORIES;
  }
}
