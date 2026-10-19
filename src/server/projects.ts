import crypto from 'node:crypto';
import {
  PROJECT_COLORS,
  type CreateProjectRequest,
  type Project,
  type ProjectColor,
  type UpdateProjectRequest,
} from '../shared/protocol.js';
import { NotFoundError, type ConsoleManager } from './consoles.js';

// Statuses that mean a PTY is (or is about to be) running
const STOPPED = new Set(['suspended', 'exited']);

export class BadRequestError extends Error {}

export function isProjectColor(value: unknown): value is ProjectColor {
  return typeof value === 'string' && (PROJECT_COLORS as readonly string[]).includes(value);
}

// Least-used color first, in PROJECT_COLORS order, so colors cycle as projects are added
export function nextProjectColor(projects: Pick<Project, 'color'>[]): ProjectColor {
  const counts = new Map<ProjectColor, number>(PROJECT_COLORS.map((c) => [c, 0]));
  for (const p of projects) counts.set(p.color, (counts.get(p.color) ?? 0) + 1);
  let best: ProjectColor = PROJECT_COLORS[0];
  for (const color of PROJECT_COLORS) if (counts.get(color)! < counts.get(best)!) best = color;
  return best;
}

// Projects live in manager.projects (persisted with the board); this owns all edits to them.
export class ProjectService {
  constructor(private readonly manager: ConsoleManager) {
    manager.on('removed', (id) => this.dropConsole(id));
  }

  get(id: string): Project {
    const project = this.manager.projects.find((p) => p.id === id);
    if (!project) throw new NotFoundError(`Unknown project ${id}`);
    return project;
  }

  create(req: CreateProjectRequest): Project {
    const name = typeof req?.name === 'string' ? req.name.trim() : '';
    if (!name) throw new BadRequestError('name is required');
    const ids = this.validIds(req.consoleIds);
    if (ids.length === 0) throw new BadRequestError('consoleIds must list at least one console');
    if (req.color !== undefined && !isProjectColor(req.color)) {
      throw new BadRequestError(`color must be one of ${PROJECT_COLORS.join(', ')}`);
    }
    const project: Project = {
      id: crypto.randomUUID(),
      name,
      color: req.color ?? nextProjectColor(this.manager.projects),
      consoleIds: [],
      open: true,
      createdAt: Date.now(),
      workspaceId: this.manager.get(ids[0])?.workspaceId ?? this.manager.activeWorkspaceId,
    };
    this.manager.projects.push(project);
    this.adopt(project, ids);
    this.changed(project);
    return project;
  }

  update(id: string, req: UpdateProjectRequest): Project {
    const project = this.get(id);
    if (req.name !== undefined) {
      if (typeof req.name !== 'string' || !req.name.trim()) {
        throw new BadRequestError('name cannot be empty');
      }
      project.name = req.name.trim();
    }
    if (req.color !== undefined) {
      if (!isProjectColor(req.color)) {
        throw new BadRequestError(`color must be one of ${PROJECT_COLORS.join(', ')}`);
      }
      project.color = req.color;
    }
    if (req.consoleIds !== undefined) {
      const ids = this.validIds(req.consoleIds);
      if (ids.length === 0) {
        throw new BadRequestError('consoleIds cannot be empty; delete the project instead');
      }
      for (const old of project.consoleIds) {
        if (!ids.includes(old)) this.setConsoleProject(old, null);
      }
      project.consoleIds = [];
      this.adopt(project, ids);
    }
    this.changed(project);
    return project;
  }

  // Ungroup: the consoles stay on the board, outside any project
  remove(id: string): void {
    const project = this.get(id);
    for (const consoleId of project.consoleIds) this.setConsoleProject(consoleId, null);
    this.deleteProject(project);
  }

  close(id: string): Project {
    const project = this.get(id);
    project.open = false;
    for (const consoleId of project.consoleIds) {
      const info = this.manager.get(consoleId);
      if (info && !STOPPED.has(info.status)) this.manager.suspend(consoleId);
    }
    this.changed(project);
    return project;
  }

  // restart() relaunches with --resume, so each conversation continues where it stopped
  open(id: string): Project {
    const project = this.get(id);
    project.open = true;
    for (const consoleId of project.consoleIds) {
      if (this.manager.get(consoleId)?.status === 'suspended') this.manager.restart(consoleId);
    }
    this.changed(project);
    return project;
  }

  private validIds(raw: unknown): string[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string')) {
      throw new BadRequestError('consoleIds must be an array of console ids');
    }
    const ids = [...new Set(raw as string[])];
    const unknown = ids.filter((id) => !this.manager.get(id));
    if (unknown.length) throw new BadRequestError(`Unknown console ${unknown[0]}`);
    return ids;
  }

  // A console belongs to one project at most: take it out of any other first
  private adopt(project: Project, ids: string[]): void {
    for (const consoleId of ids) {
      for (const other of [...this.manager.projects]) {
        if (other === project || !other.consoleIds.includes(consoleId)) continue;
        other.consoleIds = other.consoleIds.filter((c) => c !== consoleId);
        if (other.consoleIds.length === 0) this.deleteProject(other);
        else this.changed(other);
      }
      project.consoleIds.push(consoleId);
      this.setConsoleProject(consoleId, project.id);
      // A project lives on one workspace: its consoles follow it there
      const info = this.manager.get(consoleId);
      if (info && project.workspaceId && info.workspaceId !== project.workspaceId) {
        info.workspaceId = project.workspaceId;
        this.manager.touch(consoleId);
      }
    }
  }

  private setConsoleProject(consoleId: string, projectId: string | null): void {
    const info = this.manager.get(consoleId);
    if (!info || (info.projectId ?? null) === projectId) return;
    info.projectId = projectId;
    this.manager.touch(consoleId);
  }

  private dropConsole(consoleId: string): void {
    for (const project of [...this.manager.projects]) {
      if (!project.consoleIds.includes(consoleId)) continue;
      project.consoleIds = project.consoleIds.filter((c) => c !== consoleId);
      if (project.consoleIds.length === 0) this.deleteProject(project);
      else this.changed(project);
    }
  }

  private deleteProject(project: Project): void {
    const index = this.manager.projects.indexOf(project);
    if (index === -1) return;
    this.manager.projects.splice(index, 1);
    this.manager.emit('project-removed', project.id);
    this.manager.persist();
  }

  private changed(project: Project): void {
    this.manager.emit('project', project);
    this.manager.persist();
  }
}
