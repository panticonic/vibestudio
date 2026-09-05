// The Windows module is type-checked on all build hosts. Executing its APIs
// still requires Windows; compilation is not native conformance evidence.
#[allow(dead_code)]
mod windows;

mod cleanup;

fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 3 && args[1] == "--remove-workspace-trash" {
        if let Err(error) = cleanup::remove_workspace_trash(std::path::Path::new(&args[2])) {
            eprintln!("workspace cleanup failed: {error}");
            std::process::exit(125);
        }
        return;
    }
    #[cfg(target_os = "windows")]
    match windows::run() {
        Ok(code) => std::process::exit(code as i32),
        Err(error) => {
            eprintln!("isolation admission failed: {error}");
            std::process::exit(125);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        eprintln!("This platform uses its installed sandbox launcher for admission");
        std::process::exit(125);
    }
}
