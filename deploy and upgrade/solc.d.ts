declare module "solc" {
    export type ImportCallback = (path: string) => { contents: string } | { error: string };

    export function compile(input: string, options?: { import?: ImportCallback }): string;
}
