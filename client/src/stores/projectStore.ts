import { create } from 'zustand';
import type { ProjectSummary, Project } from '../types/project';
import * as api from '../api';
import { getSocket } from '../socket';

interface ProjectState {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  /** Cache of full project content keyed by id */
  projectCache: Record<string, Project>;
  /** True once fetchProjects has completed (success or failure) */
  projectsLoaded: boolean;
  /** True if the last fetchProjects call failed */
  projectsError: boolean;
}

interface ProjectActions {
  fetchProjects: () => Promise<void>;
  fetchProject: (id: string) => Promise<Project>;
  createProject: (title: string, summary: string, content: string) => Promise<Project>;
  updateProject: (id: string, data: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt'>>) => Promise<Project>;
  setActiveProject: (id: string | null) => void;
}

export const useProjectStore = create<ProjectState & ProjectActions>(
  (set, get) => {
    // Listen for server-pushed project updates (triggered when projects.json changes on disk).
    // This keeps the Projects Pane in sync without requiring a manual refresh or server restart.
    getSocket().on('projects:updated', (projects: ProjectSummary[]) => {
      set((s) => {
        // Bust cache entries whose updatedAt has changed — same logic as fetchProjects().
        const nextCache = { ...s.projectCache };
        for (const fresh of projects) {
          const cached = nextCache[fresh.id];
          if (cached && cached.updatedAt !== fresh.updatedAt) {
            delete nextCache[fresh.id];
          }
        }
        return { projects, projectCache: nextCache, projectsLoaded: true, projectsError: false };
      });
    });

    return {
    projects: [],
    activeProjectId: localStorage.getItem('medusa_active_project') ?? null,
    projectCache: {},
    projectsLoaded: false,
    projectsError: false,

    fetchProjects: async () => {
      try {
        const projects = await api.fetchProjects();
        // Bust cache entries whose updatedAt has changed — ensures ProjectPane
        // shows fresh data after external bot PATCHes (e.g. marking complete).
        set((s) => {
          const nextCache = { ...s.projectCache };
          for (const fresh of projects) {
            const cached = nextCache[fresh.id];
            if (cached && cached.updatedAt !== fresh.updatedAt) {
              delete nextCache[fresh.id];
            }
          }
          return { projects, projectCache: nextCache, projectsLoaded: true, projectsError: false };
        });
      } catch (err) {
        console.error('[projects] fetchProjects failed:', err);
        set({ projectsLoaded: true, projectsError: true });
      }
    },

    fetchProject: async (id: string) => {
      // Return cached only if still fresh (cache is busted by fetchProjects on staleness)
      const cached = get().projectCache[id];
      if (cached) return cached;

      const project = await api.fetchProject(id);
      set((s) => ({
        projectCache: { ...s.projectCache, [id]: project },
      }));
      return project;
    },

    createProject: async (title: string, summary: string, content: string) => {
      const project = await api.createProject({ title, summary, content, assignments: [] });
      set((s) => ({
        projects: [...s.projects, project],
        projectCache: { ...s.projectCache, [project.id]: project },
        activeProjectId: project.id,
      }));
      return project;
    },

    updateProject: async (id, data) => {
      const updated = await api.updateProject(id, data);
      set((s) => ({
        // Update the summary list
        projects: s.projects.map((p) => (p.id === id ? { ...p, ...updated } : p)),
        // Update the cache with full project
        projectCache: { ...s.projectCache, [id]: updated },
      }));
      return updated;
    },

    setActiveProject: (id) => {
      if (id) localStorage.setItem('medusa_active_project', id);
      else localStorage.removeItem('medusa_active_project');
      set({ activeProjectId: id });
    },
    };
  }
);
