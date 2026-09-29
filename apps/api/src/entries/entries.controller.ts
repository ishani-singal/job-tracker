import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  EducationInput,
  EntriesService,
  InternshipInput,
  ProjectInput,
  WorkExperienceInput,
} from './entries.service';

@Controller('entries')
export class EntriesController {
  constructor(private readonly entries: EntriesService) {}

  @Get()
  getAll() {
    return this.entries.getAll();
  }

  @Get('work-experience')
  listWorkExperience() {
    return this.entries.listWorkExperience();
  }
  @Post('work-experience')
  createWorkExperience(@Body() body: WorkExperienceInput) {
    return this.entries.createWorkExperience(body);
  }
  @Patch('work-experience/:id')
  updateWorkExperience(@Param('id') id: string, @Body() body: Partial<WorkExperienceInput>) {
    return this.entries.updateWorkExperience(id, body);
  }
  @Delete('work-experience/:id')
  deleteWorkExperience(@Param('id') id: string) {
    return this.entries.deleteWorkExperience(id);
  }

  @Get('education')
  listEducation() {
    return this.entries.listEducation();
  }
  @Post('education')
  createEducation(@Body() body: EducationInput) {
    return this.entries.createEducation(body);
  }
  @Patch('education/:id')
  updateEducation(@Param('id') id: string, @Body() body: Partial<EducationInput>) {
    return this.entries.updateEducation(id, body);
  }
  @Delete('education/:id')
  deleteEducation(@Param('id') id: string) {
    return this.entries.deleteEducation(id);
  }

  @Get('internships')
  listInternships() {
    return this.entries.listInternships();
  }
  @Post('internships')
  createInternship(@Body() body: InternshipInput) {
    return this.entries.createInternship(body);
  }
  @Patch('internships/:id')
  updateInternship(@Param('id') id: string, @Body() body: Partial<InternshipInput>) {
    return this.entries.updateInternship(id, body);
  }
  @Delete('internships/:id')
  deleteInternship(@Param('id') id: string) {
    return this.entries.deleteInternship(id);
  }

  @Get('projects')
  listProjects() {
    return this.entries.listProjects();
  }
  @Post('projects')
  createProject(@Body() body: ProjectInput) {
    return this.entries.createProject(body);
  }
  @Patch('projects/:id')
  updateProject(@Param('id') id: string, @Body() body: Partial<ProjectInput>) {
    return this.entries.updateProject(id, body);
  }
  @Delete('projects/:id')
  deleteProject(@Param('id') id: string) {
    return this.entries.deleteProject(id);
  }
}
