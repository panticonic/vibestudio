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
    eprintln!("Expected --remove-workspace-trash <owned-trash-directory>");
    std::process::exit(125);
}
