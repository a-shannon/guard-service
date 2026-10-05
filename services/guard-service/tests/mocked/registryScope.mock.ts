/** Capture external method state without restoring unrelated global fixtures. */
export const createRegistryMockScope = () => {
  const restorations: Array<() => void> = [];
  return {
    /** Snapshot one method and any existing mock implementation. */
    capture: (target: object, key: PropertyKey) => {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (!descriptor) throw new Error('Missing fixture method');
      const previous: unknown = descriptor.value;
      const implementation = vi.isMockFunction(previous)
        ? previous.getMockImplementation()
        : undefined;
      restorations.push(() => {
        if (vi.isMockFunction(previous)) {
          previous.mockReset();
          if (implementation) previous.mockImplementation(implementation);
        }
        Object.defineProperty(target, key, descriptor);
      });
    },
    /** Restore captured method state without clearing other fixtures. */
    restore: () =>
      restorations
        .splice(0)
        .reverse()
        .forEach((restore) => restore()),
  };
};
