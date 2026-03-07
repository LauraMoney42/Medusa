import { create } from 'zustand';

export interface FileEntry {
  file: File;
  preview: string; // blob URL for images, empty string for non-images
  isImage: boolean;
}

interface FileDropState {
  isDragging: boolean;
  pendingFiles: FileEntry[];
}

interface FileDropActions {
  setDragging: (isDragging: boolean) => void;
  addFiles: (files: FileEntry[]) => void;
  consumeFiles: () => FileEntry[];
  clearFiles: () => void;
}

export const useFileDropStore = create<FileDropState & FileDropActions>(
  (set, get) => ({
    isDragging: false,
    pendingFiles: [],

    setDragging: (isDragging) => set({ isDragging }),

    addFiles: (files) =>
      set((state) => ({
        pendingFiles: [...state.pendingFiles, ...files],
      })),

    consumeFiles: () => {
      const { pendingFiles } = get();
      if (pendingFiles.length === 0) return [];
      set({ pendingFiles: [] });
      return pendingFiles;
    },

    clearFiles: () => {
      const { pendingFiles } = get();
      // Revoke blob URLs for images to prevent memory leaks
      pendingFiles.forEach((entry) => {
        if (entry.preview) URL.revokeObjectURL(entry.preview);
      });
      set({ pendingFiles: [] });
    },
  }),
);
