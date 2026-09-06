declare module "screenshot-desktop" {
  interface Options {
    screen?: string | number;
    format?: "png" | "jpg";
    filename?: string;
  }
  interface DisplayId {
    id: string | number;
    name: string;
  }
  function screenshot(opts?: Options): Promise<Buffer>;
  namespace screenshot {
    function listDisplays(): Promise<DisplayId[]>;
    function all(opts?: Options): Promise<Buffer[]>;
  }
  export = screenshot;
}
