import { PathResolver } from '../../src/utils/path-resolver';

jest.mock('../../src/utils/log', () => ({
    logDebug: jest.fn(),
    logError: jest.fn(),
    logInfo: jest.fn()
}));

describe('PathResolver - relative mode guards', () => {
    it('should not attempt to resolve already-relative imports', async () => {
        const resolver = new PathResolver({ mode: 'relative' });
        const loadSpy = jest.spyOn<any, any>(resolver as any, 'loadPathMappingsBatch');

        const result = resolver.convertImportPathBatch('../..', '/workspace/packages/ds/src/components/foo.ts', '/workspace');

        expect(result).toBeNull();
        expect(loadSpy).not.toHaveBeenCalled();
    });
});
