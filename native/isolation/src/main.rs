// The Windows module is type-checked on all build hosts. Executing its APIs
// still requires Windows; compilation is not native conformance evidence.
#[allow(dead_code)]
mod windows;

#[cfg(target_os = "windows")]
fn main() {
    match windows::run() {
        Ok(code) => std::process::exit(code as i32),
        Err(error) => {
            eprintln!("isolation admission failed: {error}");
            std::process::exit(125);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("This native executable implements Windows admission only");
    std::process::exit(125);
}
