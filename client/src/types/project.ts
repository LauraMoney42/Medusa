export interface Assignment {
  id: string;
  owner: string;
  task: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface ProjectSummary {
  id: string;
  title: string;
  summary: string;
  status: 'active' | 'complete';
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  assignments: Assignment[];
  createdAt: string;
  updatedAt: string;
}

export interface Project extends ProjectSummary {
  content: string; // full markdown plan body
}

/** Lightweight task — alternative to full projects for quick one-off tracking */
export interface QuickTask {
  id: string;
  title: string;
  assignedTo: string;
  status: 'pending' | 'in_progress' | 'done';
  createdAt: string;
  updatedAt: string;
}
