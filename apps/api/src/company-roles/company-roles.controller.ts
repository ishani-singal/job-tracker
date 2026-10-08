import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { CompanyRolesService } from './company-roles.service';

@Controller()
export class CompanyRolesController {
  constructor(private readonly companyRoles: CompanyRolesService) {}

  @Get('tracked-companies')
  listCompanies() {
    return this.companyRoles.listCompanies();
  }

  @Post('tracked-companies')
  addCompanies(@Body() body: { companies: string }) {
    return this.companyRoles.addCompanies(body.companies);
  }

  @Post('tracked-companies/with-career-url')
  addCompanyWithCareerUrl(@Body() body: { name: string; careerPageUrl: string }) {
    return this.companyRoles.addCompanyWithCareerUrl(body.name, body.careerPageUrl);
  }

  @Post('tracked-companies/:id/rediscover')
  rediscover(@Param('id') id: string) {
    return this.companyRoles.rediscover(id);
  }

  @Delete('tracked-companies/:id')
  deleteCompany(@Param('id') id: string) {
    return this.companyRoles.deleteCompany(id);
  }

  @Get('discovered-roles')
  listRoles(@Query('filter') filter?: 'unselected' | 'selected') {
    return this.companyRoles.listRoles({
      unselectedOnly: filter === 'unselected',
      selectedOnly: filter === 'selected',
    });
  }

  @Post('discovered-roles/:id/select')
  selectRole(@Param('id') id: string) {
    return this.companyRoles.selectRole(id);
  }

  @Post('discovered-roles/:id/unselect')
  unselectRole(@Param('id') id: string) {
    return this.companyRoles.unselectRole(id);
  }

  @Post('discovered-roles/:id/rescore')
  rescoreRole(@Param('id') id: string) {
    return this.companyRoles.rescoreRole(id);
  }

  @Post('discovered-roles/:id/discard')
  discardRole(@Param('id') id: string) {
    return this.companyRoles.discardRole(id);
  }
}
