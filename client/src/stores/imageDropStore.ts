import { create } from 'zustand';

interface ImageEntry {
  file: File;
  preview: string;
}

interface ImageDropState {
  isDragging: boolean;
  pendingImages: ImageEntry[];
}

interface ImageDropActions {
  setDragging: (isDragging: boolean) => void;
  addImages: (images: ImageEntry[]) => void;
  consumeImages: () => ImageEntry[];
  clearImages: () => void;
}

export const useImageDropStore = create<ImageDropState & ImageDropActions>(
  (set, get) => ({
    isDragging: false,
    pendingImages: [],

    setDragging: (isDragging) => set({ isDragging }),

    addImages: (images) =>
      set((state) => ({
        pendingImages: [...state.pendingImages, ...images],
      })),

    consumeImages: () => {
      const { pendingImages } = get();
      if (pendingImages.length === 0) return [];
      set({ pendingImages: [] });
      return pendingImages;
    },

    clearImages: () => {
      const { pendingImages } = get();
      // Revoke all blob URLs to prevent memory leaks
      pendingImages.forEach((entry) => URL.revokeObjectURL(entry.preview));
      set({ pendingImages: [] });
    },
  }),
);
