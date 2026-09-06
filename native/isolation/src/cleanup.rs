use std::{fs, io, path::Path};

/// The catalog owner supplies a privately staged deletion directory. Rust's
/// platform implementation removes through directory handles (openat/unlinkat
/// on Unix, NtCreateFile/SetFileInformationByHandle on Windows), protecting the
/// recursive walk from guest symlink replacement. Do not replace with Node rm.
/// Contract: https://doc.rust-lang.org/std/fs/fn.remove_dir_all.html
pub fn remove_workspace_trash(root: &Path) -> io::Result<()> {
    if !root.is_absolute()
        || !root
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(".delete-"))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Expected owned workspace trash",
        ));
    }
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Trash anchor is not a directory",
            ));
        }
        Ok(_) => {}
    }
    // Keep the protected catalog receipt until the guest-writable subtree is
    // gone, so timeout or concurrent writes leave a recoverable deletion.
    match fs::remove_dir_all(root.join("workspace")) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    match fs::remove_file(root.join("deletion.json")) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    fs::remove_dir(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn directory_replacement_cannot_redirect_cleanup() {
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let fixture =
            std::env::temp_dir().join(format!("isolation-cleanup-race-{}", std::process::id()));
        fs::create_dir(&fixture).unwrap();
        let trash = fixture.join(".delete-race");
        let node = trash.join("workspace").join("node");
        let parked = trash.join("workspace").join("parked");
        let outside = fixture.join("outside");
        fs::create_dir_all(&node).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("canary"), b"host data").unwrap();
        for index in 0..500 {
            fs::write(node.join(index.to_string()), b"scratch").unwrap();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let running = stop.clone();
        let target = outside.clone();
        let attacker = std::thread::spawn(move || {
            while !running.load(Ordering::Relaxed) {
                if fs::rename(&node, &parked).is_ok() {
                    let _ = std::os::unix::fs::symlink(&target, &node);
                    std::thread::yield_now();
                    let _ = fs::remove_file(&node);
                    let _ = fs::rename(&parked, &node);
                }
            }
        });
        let _ = remove_workspace_trash(&trash);
        stop.store(true, Ordering::Relaxed);
        attacker.join().unwrap();
        assert_eq!(fs::read(outside.join("canary")).unwrap(), b"host data");
        fs::remove_dir_all(fixture).unwrap();
    }

    #[test]
    fn removes_links_without_removing_their_targets() {
        let fixture =
            std::env::temp_dir().join(format!("isolation-cleanup-{}", std::process::id()));
        fs::create_dir(&fixture).unwrap();
        let trash = fixture.join(".delete-fixture");
        let outside = fixture.join("outside");
        fs::create_dir_all(trash.join("workspace")).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("canary"), b"host data").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, trash.join("workspace/link")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&outside, trash.join("workspace/link")).unwrap();
        remove_workspace_trash(&trash).unwrap();
        assert_eq!(fs::read(outside.join("canary")).unwrap(), b"host data");
        fs::remove_dir_all(fixture).unwrap();
    }
}
