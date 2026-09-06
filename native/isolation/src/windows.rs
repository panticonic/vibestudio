use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::c_void,
    fs, io,
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, Isolation::*, *},
    Storage::FileSystem::*,
    System::{Console::*, JobObjects::*, SystemInformation::*, Threading::*},
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}
fn check(ok: i32) -> Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error().into())
    } else {
        Ok(())
    }
}
fn status(code: u32) -> Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code as i32).into())
    }
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// Undo successful mutations in the opposite order, including during an early
/// return. A Vec's element-drop order is not a transaction rollback order.
struct RollbackStack<T> {
    entries: Vec<T>,
}
impl<T> RollbackStack<T> {
    fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
    fn push(&mut self, value: T) {
        self.entries.push(value);
    }
}
impl<T> Drop for RollbackStack<T> {
    fn drop(&mut self) {
        while let Some(value) = self.entries.pop() {
            drop(value);
        }
    }
}

struct OwnedJob {
    handle: Handle,
    retired: bool,
    retirement_deadline: Option<Instant>,
}

fn wait_for_empty_job(mut active: impl FnMut() -> Result<u32>, deadline: Instant) -> Result<()> {
    loop {
        if active()? == 0 {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Job termination deadline exceeded; descendant exit is unconfirmed".into());
        }
        std::thread::sleep(remaining.min(Duration::from_millis(10)));
    }
}

impl OwnedJob {
    fn retire(&mut self) -> Result<()> {
        if self.retired {
            return Ok(());
        }
        // Termination can wait on pending kernel I/O. Never hold the launcher
        // and its private storage lock forever. Drop shares this deadline, so
        // an explicit failed retirement cannot start another unbounded wait.
        let deadline = *self
            .retirement_deadline
            .get_or_insert_with(|| Instant::now() + Duration::from_secs(2));
        unsafe {
            check(TerminateJobObject(self.handle.0, 125))?;
            wait_for_empty_job(
                || {
                    let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
                    check(QueryInformationJobObject(
                        self.handle.0,
                        JobObjectBasicAccountingInformation,
                        (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                        size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                        null_mut(),
                    ))?;
                    Ok(accounting.ActiveProcesses)
                },
                deadline,
            )?;
        }
        self.retired = true;
        Ok(())
    }
}
impl Drop for OwnedJob {
    fn drop(&mut self) {
        if let Err(error) = self.retire() {
            // Fail without restoring security resources underneath a possibly
            // live guest. Process termination closes the private kill-on-close
            // job handle. A nonzero exit must not be reported as clean teardown.
            eprintln!("Cannot establish complete domain retirement: {error}");
            std::process::abort();
        }
    }
}

struct Local(*mut c_void);
impl Drop for Local {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
struct Profile {
    name: Vec<u16>,
    sid: PSID,
    persistent: bool,
}
impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            if !self.persistent {
                DeleteAppContainerProfile(self.name.as_ptr());
            }
            FreeSid(self.sid);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    workspace_id: String,
    context_id: Option<String>,
    runtime_id: String,
    incarnation: String,
    execution_digest: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    version: u32,
    owner: Owner,
    private_root: String,
    executable: String,
    args: Vec<String>,
    cwd: String,
    home: String,
    environment: BTreeMap<String, String>,
    read: Vec<String>,
    write: Vec<String>,
    sockets: Vec<String>,
}

/// Protected ownership state; launch incarnations and broker sessions remain fresh.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageDomain {
    version: u32,
    workspace_id: String,
    profile_name: String,
    writable_roots: Vec<String>,
    retired: bool,
}

// Windows command-line encoding follows CommandLineToArgvW rules, including
// trailing slashes before the closing quote. No shell interprets this string.
fn quote(value: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in value.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        if c == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
        } else {
            out.push_str(&"\\".repeat(slashes));
        }
        slashes = 0;
        out.push(c);
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}

/// Windows environment names are case-insensitive and the Unicode block must
/// be sorted accordingly. The common policy already uses ASCII identifier
/// names; enforcing it here avoids locale-dependent aliasing in native input.
fn environment_block(
    environment: &BTreeMap<String, String>,
    home: &str,
    system_root: &str,
) -> Result<Vec<u16>> {
    let mut entries = BTreeMap::new();
    for (key, value) in environment {
        let mut chars = key.bytes();
        if !chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
            || !chars.all(|c| c.is_ascii_alphanumeric() || c == b'_')
            || value.contains('\0')
        {
            return Err("Invalid environment entry".into());
        }
        if entries
            .insert(key.to_ascii_uppercase(), value.clone())
            .is_some()
        {
            return Err("Duplicate case-insensitive environment entry".into());
        }
    }
    for (key, value) in [
        ("HOME", home),
        ("USERPROFILE", home),
        ("SYSTEMROOT", system_root),
    ] {
        if value.contains('\0') {
            return Err("Invalid runtime environment coordinate".into());
        }
        entries.insert(key.into(), value.into());
    }
    let mut block = Vec::new();
    for (key, value) in entries {
        block.extend(wide(&format!("{key}={value}")));
    }
    block.push(0);
    Ok(block)
}

fn canonical(value: &str) -> Result<String> {
    if value.contains('\0')
        || value.starts_with("\\\\")
        || value.len() < 3
        || value.as_bytes()[1] != b':'
        || value[2..].contains(':')
    {
        return Err("Only local drive paths are admitted".into());
    }
    // Reject every reparse-point component before touching its ACL. The
    // private-root lock excludes other admitted writers during setup.
    let mut prefix = String::new();
    for component in value.split('\\') {
        if !prefix.is_empty() {
            prefix.push('\\');
        }
        prefix.push_str(component);
        if prefix.len() <= 2 {
            continue;
        }
        let attributes = unsafe { GetFileAttributesW(wide(&prefix).as_ptr()) };
        if attributes == INVALID_FILE_ATTRIBUTES {
            return Err(io::Error::last_os_error().into());
        }
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("Reparse-point resources are not admitted".into());
        }
    }
    let normalized = fs::canonicalize(value)?
        .to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .to_ascii_lowercase();
    if normalized != value.to_ascii_lowercase() {
        return Err("Resource is not a canonical path".into());
    }
    Ok(normalized)
}

unsafe fn pin_security_object(resource: &str) -> Result<Handle> {
    unsafe {
        let handle = CreateFileW(
            wide(resource).as_ptr(),
            READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error().into());
        }
        let object = Handle(handle);
        let mut info: BY_HANDLE_FILE_INFORMATION = zeroed();
        check(GetFileInformationByHandle(object.0, &mut info))?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 && info.nNumberOfLinks != 1)
        {
            return Err("Security resources must be private objects without links".into());
        }
        Ok(object)
    }
}

/// Writable directory anchors remain stable for the whole admitted lifetime.
/// Sharing blocks data-write handles; the root-only ACL below also denies
/// attribute-only reparse operations and deletion without restricting children.
unsafe fn pin_write_anchor(resource: &str) -> Result<Handle> {
    unsafe {
        let raw = CreateFileW(
            wide(resource).as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        );
        if raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error().into());
        }
        let object = Handle(raw);
        let mut info: BY_HANDLE_FILE_INFORMATION = zeroed();
        check(GetFileInformationByHandle(object.0, &mut info))?;
        if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            return Err("Writable anchors must be ordinary directories".into());
        }
        canonical(resource)?;
        Ok(object)
    }
}

enum ResourceAccess {
    Immutable,
    WritableRoot,
}

struct AclGrant {
    object: Handle,
    descriptor: Local,
    original: *mut ACL,
    persistent: bool,
}

// Writable LPAC state needs a low mandatory-integrity label as well as a
// matching DACL. Changing either on a hardlinked/reparse resource could alter
// an unrelated host object, so staging is checked before any security mutation.
fn staged_tree(resource: &str) -> Result<Vec<String>> {
    canonical(resource)?;
    let attributes = unsafe { GetFileAttributesW(wide(resource).as_ptr()) };
    let mut result = vec![resource.to_owned()];
    if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        for entry in fs::read_dir(resource)? {
            result.extend(staged_tree(&entry?.path().to_string_lossy())?);
        }
    } else {
        unsafe {
            let handle = CreateFileW(
                wide(resource).as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error().into());
            }
            let handle = Handle(handle);
            let mut info: BY_HANDLE_FILE_INFORMATION = zeroed();
            check(GetFileInformationByHandle(handle.0, &mut info))?;
            if info.nNumberOfLinks != 1 {
                return Err("Staged input/state must not be hardlinked to other domains".into());
            }
        }
    }
    Ok(result)
}

struct IntegrityGrant {
    object: Handle,
    descriptor: Local,
    original: *mut ACL,
    persistent: bool,
}
impl IntegrityGrant {
    unsafe fn install(resource: &str) -> Result<Self> {
        unsafe {
            let object = pin_security_object(resource)?;
            let mut original = null_mut();
            let mut descriptor = null_mut();
            status(GetSecurityInfo(
                object.0,
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                &mut original,
                &mut descriptor,
            ))?;
            let descriptor = Local(descriptor);
            let mut low = null_mut();
            check(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide("S:(ML;OICI;NW;;;LW)").as_ptr(),
                SDDL_REVISION_1,
                &mut low,
                null_mut(),
            ))?;
            let _low = Local(low);
            let mut acl = null_mut();
            let mut present = 0;
            let mut defaulted = 0;
            check(GetSecurityDescriptorSacl(
                low,
                &mut present,
                &mut acl,
                &mut defaulted,
            ))?;
            if present == 0 || acl.is_null() {
                return Err("Cannot construct private-state integrity label".into());
            }
            let grant = Self {
                object,
                descriptor,
                original,
                persistent: false,
            };
            status(SetSecurityInfo(
                grant.object.0,
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                acl,
            ))?;
            Ok(grant)
        }
    }
}
impl Drop for IntegrityGrant {
    fn drop(&mut self) {
        if self.persistent {
            return;
        }
        unsafe {
            // This rollback is only armed before the first guest is started.
            // Use the filesystem API so inherited labels are restored too.
            let code = SetSecurityInfo(
                self.object.0,
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                self.original,
            );
            if code != ERROR_SUCCESS {
                eprintln!(
                    "Cannot restore retired private-state integrity label: {}",
                    io::Error::from_raw_os_error(code as i32)
                );
            }
        }
    }
}
impl AclGrant {
    unsafe fn restore(&mut self) -> Result<()> {
        if self.persistent {
            return Ok(());
        }
        unsafe {
            // Only immutable read trees or pre-guest provisioning roll back.
            // Guest-writable grants are persistent and never traverse here.
            // Restore inherited child ACEs as well as the pinned root: the
            // persistent storage SID must not retain a past read admission.
            status(SetSecurityInfo(
                self.object.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                self.original,
                null_mut(),
            ))?;
        }
        self.persistent = true;
        Ok(())
    }

    unsafe fn install(resource: &str, sid: PSID, access: ResourceAccess) -> Result<Self> {
        unsafe {
            let object = pin_security_object(resource)?;
            let mut descriptor = null_mut();
            let mut original = null_mut();
            status(GetSecurityInfo(
                object.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut original,
                null_mut(),
                &mut descriptor,
            ))?;
            let descriptor = Local(descriptor);
            let mut entry: EXPLICIT_ACCESS_W = zeroed();
            entry.grfAccessPermissions = match access {
                ResourceAccess::Immutable => FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                ResourceAccess::WritableRoot => {
                    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE
                }
            };
            entry.grfAccessMode = GRANT_ACCESS;
            entry.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
            entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
            entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
            entry.Trustee.ptstrName = sid.cast();
            let mut updated = null_mut();
            let mut entries = vec![entry];
            if matches!(access, ResourceAccess::WritableRoot) {
                let mut deny: EXPLICIT_ACCESS_W = zeroed();
                deny.grfAccessPermissions = DELETE | FILE_WRITE_ATTRIBUTES;
                deny.grfAccessMode = DENY_ACCESS;
                deny.grfInheritance = NO_INHERITANCE;
                deny.Trustee.TrusteeForm = TRUSTEE_IS_SID;
                deny.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
                deny.Trustee.ptstrName = sid.cast();
                entries.push(deny);
            }
            status(SetEntriesInAclW(
                entries.len() as u32,
                entries.as_ptr(),
                original,
                &mut updated,
            ))?;
            let _updated = Local(updated.cast());
            let grant = Self {
                object,
                descriptor,
                original,
                persistent: false,
            };
            status(SetSecurityInfo(
                grant.object.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                updated,
                null_mut(),
            ))?;
            Ok(grant)
        }
    }
}
impl Drop for AclGrant {
    fn drop(&mut self) {
        unsafe {
            if let Err(error) = self.restore() {
                eprintln!("Cannot restore retired private-state ACL: {error}");
            }
        }
    }
}

struct Attributes {
    storage: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    unsafe fn new(count: u32) -> Result<Self> {
        unsafe {
            let mut bytes = 0;
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
            let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            let list = storage.as_mut_ptr().cast();
            check(InitializeProcThreadAttributeList(
                list, count, 0, &mut bytes,
            ))?;
            Ok(Self { storage, list })
        }
    }
    unsafe fn set<T>(&self, key: usize, value: &T) -> Result<()> {
        unsafe {
            check(UpdateProcThreadAttribute(
                self.list,
                0,
                key,
                (value as *const T).cast(),
                size_of::<T>(),
                null_mut(),
                null(),
            ))
        }
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.list);
        }
    }
}

unsafe fn lock_domain(root: &str) -> Result<Handle> {
    unsafe {
        let raw = CreateFileW(
            wide(&format!("{root}\\.isolation-owner.lock")).as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            null(),
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_HIDDEN,
            null_mut(),
        );
        if raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error().into());
        }
        Ok(Handle(raw))
    }
}

fn read_storage_domain(file: &str) -> Result<Option<StorageDomain>> {
    let bytes = match fs::read(file) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if bytes.len() > 64 * 1024 {
        return Err("Storage domain record exceeds limit".into());
    }
    let domain: StorageDomain = serde_json::from_slice(&bytes)?;
    if domain.version != 1
        || !domain.profile_name.starts_with("vibestudio.")
        || domain.profile_name.len() != "vibestudio.".len() + 32
        || !domain.profile_name["vibestudio.".len()..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
    {
        return Err("Invalid storage domain record".into());
    }
    Ok(Some(domain))
}

fn write_storage_domain(file: &str, domain: &StorageDomain) -> Result<()> {
    use std::io::Write;
    let mut random = [0u8; 16];
    unsafe { SystemFunction036(random.as_mut_ptr().cast(), random.len() as u32) }
        .then_some(())
        .ok_or("Cannot create storage transaction identity")?;
    let temporary = format!(
        "{file}.{}",
        random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    );
    let mut pending = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| -> Result<()> {
        pending.write_all(&serde_json::to_vec(domain)?)?;
        pending.sync_all()?;
        drop(pending);
        unsafe {
            check(MoveFileExW(
                wide(&temporary).as_ptr(),
                wide(file).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            ))?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Installed-owner operation after workspace retirement. It never traverses
/// guest storage, and a retired ownership record can never launch again.
pub(crate) fn retire_storage(root: &str) -> Result<u32> {
    let root = canonical(root)?;
    if root.len() <= 3 {
        return Err("Host drive root is not a private domain".into());
    }
    unsafe {
        let _lock = lock_domain(&root)?;
        let file = format!("{root}\\.isolation-domain.json");
        let Some(mut domain) = read_storage_domain(&file)? else {
            return Ok(0);
        };
        if !domain.retired {
            domain.retired = true;
            write_storage_domain(&file, &domain)?;
        }
        let hr = DeleteAppContainerProfile(wide(&domain.profile_name).as_ptr());
        if hr < 0 {
            return Err(format!("Cannot remove retired storage profile: {hr:#x}").into());
        }
    }
    Ok(0)
}

pub fn run() -> Result<u32> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 3 && args[1] == "--retire-storage" {
        return retire_storage(&args[2]);
    }
    if args.len() != 2 {
        return Err("Expected one installed-owner policy file".into());
    }
    let bytes = fs::read(&args[1])?;
    if bytes.len() > 1024 * 1024 {
        return Err("Execution policy exceeds limit".into());
    }
    let p: Policy = serde_json::from_slice(&bytes)?;
    if p.version != 1 || !p.sockets.is_empty() {
        return Err("Unsupported policy version or Unix IPC resource".into());
    }
    for field in [
        &p.owner.workspace_id,
        &p.owner.runtime_id,
        &p.owner.incarnation,
        &p.owner.execution_digest,
    ] {
        if field.is_empty() || field.contains('\0') {
            return Err("Missing execution ownership".into());
        }
    }
    let root = canonical(&p.private_root)?;
    if root.len() <= 3 {
        return Err("Host drive root is not a private domain".into());
    }
    let prefix = format!("{root}\\");
    for resource in p.read.iter().chain(&p.write) {
        if !canonical(resource)?.starts_with(&prefix) {
            return Err("Resource must be staged below the private domain root".into());
        }
    }
    let executable = canonical(&p.executable)?;
    let cwd = canonical(&p.cwd)?;
    let home = canonical(&p.home)?;
    let within = |resource: &str, roots: &[String]| {
        roots.iter().any(|r| {
            resource == r.to_ascii_lowercase()
                || resource.starts_with(&format!("{}\\", r.to_ascii_lowercase()))
        })
    };
    if !within(&executable, &p.read)
        || !within(&home, &p.write)
        || (!within(&cwd, &p.read) && !within(&cwd, &p.write))
    {
        return Err("Executable, home or working directory is not admitted".into());
    }
    for r in &p.read {
        if within(&r.to_ascii_lowercase(), &p.write) {
            return Err("Writable immutable input".into());
        }
    }
    for w in &p.write {
        if within(&w.to_ascii_lowercase(), &p.read) {
            return Err("Overlapping resource scopes".into());
        }
    }
    if p.args.iter().any(|a| a.contains('\0')) {
        return Err("Invalid process argument".into());
    }

    unsafe {
        let mut system = vec![0u16; 32768];
        let length = GetWindowsDirectoryW(system.as_mut_ptr(), system.len() as u32);
        if length == 0 || length as usize >= system.len() {
            return Err("Cannot resolve Windows runtime directory".into());
        }
        // Validate before persistent storage security is changed. These are
        // exact closed inputs, never the launcher's inherited environment.
        let block = environment_block(
            &p.environment,
            &p.home,
            &String::from_utf16(&system[..length as usize])?,
        )?;
        let _lock = lock_domain(&p.private_root)?;
        let _write_anchors = p
            .write
            .iter()
            .map(|resource| pin_write_anchor(resource))
            .collect::<Result<Vec<_>>>()?;
        // Complete the entire staging inspection before changing the first ACL.
        for resource in &p.read {
            staged_tree(resource)?;
        }
        let domain_path = format!("{}\\.isolation-domain.json", p.private_root);
        let stored = read_storage_domain(&domain_path)?;
        if let Some(domain) = &stored {
            if domain.retired
                || domain.workspace_id != p.owner.workspace_id
                || domain.writable_roots != p.write
            {
                return Err("Storage domain ownership does not match admission".into());
            }
        }
        let fresh = stored.is_none();
        let domain = if let Some(domain) = stored {
            domain
        } else {
            let mut random = [0u8; 16];
            SystemFunction036(random.as_mut_ptr().cast(), random.len() as u32)
                .then_some(())
                .ok_or("Cannot create domain identity")?;
            StorageDomain {
                version: 1,
                workspace_id: p.owner.workspace_id.clone(),
                profile_name: format!(
                    "vibestudio.{}",
                    random
                        .iter()
                        .map(|b| format!("{b:02x}"))
                        .collect::<String>()
                ),
                writable_roots: p.write.clone(),
                retired: false,
            }
        };
        let name = wide(&domain.profile_name);
        let mut sid = null_mut();
        let hr = if fresh {
            CreateAppContainerProfile(
                name.as_ptr(),
                name.as_ptr(),
                name.as_ptr(),
                null(),
                0,
                &mut sid,
            )
        } else {
            DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid)
        };
        if hr < 0 {
            return Err(format!("Cannot resolve AppContainer profile: {hr:#x}").into());
        }
        let mut profile = Profile {
            name,
            sid,
            persistent: !fresh,
        };
        let mut integrity = RollbackStack::new();
        let mut storage_grants = RollbackStack::new();
        if fresh {
            // Only first provisioning sees a host-prepared, link-free tree.
            // Never walk or rewrite security on guest-controlled descendants at restart.
            let writable_tree = p
                .write
                .iter()
                .map(|resource| staged_tree(resource))
                .collect::<Result<Vec<_>>>()?;
            // Capture descendants before a parent's inheritable low label
            // changes them, including when write roots overlap. Every saved
            // descriptor must predate provisioning, not an earlier mutation.
            let mut writable_objects: Vec<_> = writable_tree.into_iter().flatten().collect();
            writable_objects.sort_by_key(|resource| {
                (
                    std::cmp::Reverse(resource.matches('\\').count()),
                    resource.to_ascii_lowercase(),
                )
            });
            writable_objects.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
            for resource in &writable_objects {
                integrity.push(IntegrityGrant::install(resource)?);
            }
            for resource in &p.write {
                storage_grants.push(AclGrant::install(
                    resource,
                    sid,
                    ResourceAccess::WritableRoot,
                )?);
            }
            write_storage_domain(&domain_path, &domain)?;
            profile.persistent = true;
            for grant in &mut storage_grants.entries {
                grant.persistent = true;
            }
            for grant in &mut integrity.entries {
                grant.persistent = true;
            }
        }
        // Committed storage security no longer needs rollback descriptors or
        // per-file handles. Only immutable anchors are pinned for the lifetime.
        drop(storage_grants);
        drop(integrity);
        let mut grants = RollbackStack::new();
        for resource in &p.read {
            grants.push(AclGrant::install(resource, sid, ResourceAccess::Immutable)?);
        }
        let job_raw = CreateJobObjectW(null(), null());
        if job_raw.is_null() {
            return Err(io::Error::last_os_error().into());
        }
        let mut job = OwnedJob {
            handle: Handle(job_raw),
            retired: false,
            retirement_deadline: None,
        };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit = 256;
        check(SetInformationJobObject(
            job.handle.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ))?;
        let capabilities = SECURITY_CAPABILITIES {
            AppContainerSid: sid,
            Capabilities: null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        };
        let attributes = Attributes::new(4)?;
        attributes.set(
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            &capabilities,
        )?;
        attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST as usize, &job.handle.0)?;
        let lpac: u32 = 1; // PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT
        attributes.set(
            PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY as usize,
            &lpac,
        )?;
        let current = GetCurrentProcess();
        let mut stdio = Vec::new();
        for channel in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let source = GetStdHandle(channel);
            let mut copy = null_mut();
            check(DuplicateHandle(
                current,
                source,
                current,
                &mut copy,
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            ))?;
            stdio.push(Handle(copy));
        }
        let handles = [stdio[0].0, stdio[1].0, stdio[2].0];
        check(UpdateProcThreadAttribute(
            attributes.list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast(),
            size_of_val(&handles),
            null_mut(),
            null(),
        ))?;
        let mut startup: STARTUPINFOEXW = zeroed();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[1];
        startup.StartupInfo.hStdError = handles[2];
        startup.lpAttributeList = attributes.list;
        let mut command = wide(
            &std::iter::once(&p.executable)
                .chain(&p.args)
                .map(|a| quote(a))
                .collect::<Vec<_>>()
                .join(" "),
        );
        let mut process: PROCESS_INFORMATION = zeroed();
        check(CreateProcessW(
            wide(&p.executable).as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | CREATE_SUSPENDED,
            block.as_ptr().cast(),
            wide(&p.cwd).as_ptr(),
            &startup.StartupInfo,
            &mut process,
        ))?;
        let thread = Handle(process.hThread);
        let process = Handle(process.hProcess);
        // Verify the kernel result before the first guest instruction. Requested
        // attributes and a self-reported "sandboxed" environment are not evidence.
        let mut token = null_mut();
        check(OpenProcessToken(process.0, TOKEN_QUERY, &mut token))?;
        let token = Handle(token);
        for property in [TokenIsAppContainer, TokenIsLessPrivilegedAppContainer] {
            let mut value = 0u32;
            let mut returned = 0;
            check(GetTokenInformation(
                token.0,
                property,
                (&mut value as *mut u32).cast(),
                size_of::<u32>() as u32,
                &mut returned,
            ))?;
            if value != 1 {
                return Err("Kernel did not create the requested LPAC boundary".into());
            }
        }
        let mut bytes = 0;
        GetTokenInformation(token.0, TokenAppContainerSid, null_mut(), 0, &mut bytes);
        if bytes < size_of::<TOKEN_APPCONTAINER_INFORMATION>() as u32 {
            return Err("Kernel did not expose the AppContainer identity".into());
        }
        let mut sid_storage = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
        check(GetTokenInformation(
            token.0,
            TokenAppContainerSid,
            sid_storage.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        ))?;
        let actual = &*(sid_storage
            .as_ptr()
            .cast::<TOKEN_APPCONTAINER_INFORMATION>());
        if actual.TokenAppContainer.is_null() || EqualSid(actual.TokenAppContainer, sid) == 0 {
            return Err("Kernel AppContainer identity differs from the admitted domain".into());
        }
        let mut member = 0;
        check(IsProcessInJob(process.0, job.handle.0, &mut member))?;
        if member == 0 {
            return Err("Kernel process is outside its owned Job Object".into());
        }
        if ResumeThread(thread.0) == u32::MAX {
            return Err(io::Error::last_os_error().into());
        }
        if WaitForSingleObject(process.0, INFINITE) != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error().into());
        }
        let mut code = 0;
        check(GetExitCodeProcess(process.0, &mut code))?;
        job.retire()?;
        drop(job);
        // A failed read-grant cleanup is not a successful helper teardown.
        // All guest processes are observed gone before walking immutable inputs.
        for grant in grants.entries.iter_mut().rev() {
            grant.restore()?;
        }
        drop(grants);
        Ok(code)
    }
}

#[cfg_attr(target_os = "windows", link(name = "advapi32"))]
unsafe extern "system" {
    fn SystemFunction036(buffer: *mut c_void, length: u32) -> bool;
}

#[cfg(test)]
mod tests {
    use super::{RollbackStack, environment_block, quote, wait_for_empty_job};
    use std::{
        collections::BTreeMap,
        time::{Duration, Instant},
    };
    #[test]
    fn command_line_preserves_empty_quotes_and_trailing_slashes() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("two words"), "\"two words\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote("C:\\dir\\"), "\"C:\\dir\\\\\"");
    }

    #[test]
    fn rollback_restores_parent_before_previously_installed_descendants() {
        use std::{cell::RefCell, rc::Rc};
        struct Mutation(&'static str, Rc<RefCell<Vec<&'static str>>>);
        impl Drop for Mutation {
            fn drop(&mut self) {
                self.1.borrow_mut().push(self.0);
            }
        }
        let restored = Rc::new(RefCell::new(Vec::new()));
        let provision = || -> std::result::Result<(), &'static str> {
            let mut mutations = RollbackStack::new();
            for resource in ["leaf", "directory", "root"] {
                mutations.push(Mutation(resource, restored.clone()));
            }
            Err("later provisioning failed")
        };
        assert!(provision().is_err());
        assert_eq!(&*restored.borrow(), &["root", "directory", "leaf"]);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn pinned_anchor_preserves_child_acl_and_integrity_inheritance() -> super::Result<()> {
        use super::*;
        // WinNT.h ACE_HEADER values; avoid enabling SystemServices solely for
        // these two constants in this native regression.
        const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
        const SYSTEM_MANDATORY_LABEL_ACE_TYPE: u8 = 0x11;
        struct Fixture(std::path::PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).expect("remove native security fixture");
            }
        }
        unsafe fn has_sid(
            resource: &str,
            information: u32,
            sid: PSID,
            ace_type: u8,
        ) -> Result<bool> {
            unsafe {
                let handle = pin_security_object(resource)?;
                let mut acl = null_mut();
                let mut descriptor = null_mut();
                status(GetSecurityInfo(
                    handle.0,
                    SE_FILE_OBJECT,
                    information,
                    null_mut(),
                    null_mut(),
                    if information == DACL_SECURITY_INFORMATION {
                        &mut acl
                    } else {
                        null_mut()
                    },
                    if information == LABEL_SECURITY_INFORMATION {
                        &mut acl
                    } else {
                        null_mut()
                    },
                    &mut descriptor,
                ))?;
                let _descriptor = Local(descriptor);
                if acl.is_null() {
                    return Ok(false);
                }
                let mut size: ACL_SIZE_INFORMATION = zeroed();
                check(GetAclInformation(
                    acl,
                    (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                ))?;
                for index in 0..size.AceCount {
                    let mut ace = null_mut();
                    check(GetAce(acl, index, &mut ace))?;
                    if (*(ace as *const ACE_HEADER)).AceType == ace_type {
                        // Both tested ACE forms carry Mask followed by SidStart.
                        let actual =
                            std::ptr::addr_of!((*(ace as *const ACCESS_ALLOWED_ACE)).SidStart);
                        if EqualSid(actual.cast_mut().cast(), sid) != 0 {
                            return Ok(true);
                        }
                    }
                }
                Ok(false)
            }
        }
        unsafe fn security_snapshot(
            resource: &str,
            information: u32,
        ) -> Result<(u16, Vec<Vec<u8>>)> {
            unsafe {
                let handle = pin_security_object(resource)?;
                let mut acl = null_mut();
                let mut descriptor = null_mut();
                status(GetSecurityInfo(
                    handle.0,
                    SE_FILE_OBJECT,
                    information,
                    null_mut(),
                    null_mut(),
                    if information == DACL_SECURITY_INFORMATION {
                        &mut acl
                    } else {
                        null_mut()
                    },
                    if information == LABEL_SECURITY_INFORMATION {
                        &mut acl
                    } else {
                        null_mut()
                    },
                    &mut descriptor,
                ))?;
                let _descriptor = Local(descriptor);
                let mut control = 0;
                let mut revision = 0;
                check(GetSecurityDescriptorControl(
                    descriptor,
                    &mut control,
                    &mut revision,
                ))?;
                // Ignore automatic-inheritance bookkeeping and unused ACL
                // capacity. An absent/empty label SACL both mean no explicit
                // label; DACL presence and protection still affect authority.
                let control = control
                    & if information == DACL_SECURITY_INFORMATION {
                        SE_DACL_PRESENT | SE_DACL_PROTECTED
                    } else {
                        SE_SACL_PROTECTED
                    };
                let mut aces = Vec::new();
                if !acl.is_null() {
                    let mut size: ACL_SIZE_INFORMATION = zeroed();
                    check(GetAclInformation(
                        acl,
                        (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                        size_of::<ACL_SIZE_INFORMATION>() as u32,
                        AclSizeInformation,
                    ))?;
                    for index in 0..size.AceCount {
                        let mut ace = null_mut();
                        check(GetAce(acl, index, &mut ace))?;
                        let size = (*(ace as *const ACE_HEADER)).AceSize as usize;
                        aces.push(std::slice::from_raw_parts(ace.cast::<u8>(), size).to_vec());
                    }
                }
                Ok((control, aces))
            }
        }
        let directory = std::env::temp_dir().join(format!(
            "vibestudio-anchor-inheritance-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        fs::create_dir(&directory)?;
        let _fixture = Fixture(directory.clone());
        let directory = directory.to_string_lossy().to_string();
        let child = format!("{directory}\\existing-child");
        fs::write(&child, "fixture")?;
        let inherited_child = format!("{directory}\\inheritance-only-child");
        fs::write(&inherited_child, "fixture")?;
        unsafe {
            let mut sid = null_mut();
            check(ConvertStringSidToSidW(
                wide("S-1-15-2-999-998-997-996-995-994-993").as_ptr(),
                &mut sid,
            ))?;
            let _sid = Local(sid);
            let mut low = null_mut();
            check(ConvertStringSidToSidW(
                wide("S-1-16-4096").as_ptr(),
                &mut low,
            ))?;
            let _low = Local(low);
            let _anchor = pin_write_anchor(&directory)?;
            let original_root_acl = security_snapshot(&directory, DACL_SECURITY_INFORMATION)?;
            let original_child_acl = security_snapshot(&child, DACL_SECURITY_INFORMATION)?;
            let original_root_label = security_snapshot(&directory, LABEL_SECURITY_INFORMATION)?;
            let original_child_label = security_snapshot(&child, LABEL_SECURITY_INFORMATION)?;
            let original_inherited_label =
                security_snapshot(&inherited_child, LABEL_SECURITY_INFORMATION)?;
            assert!(!has_sid(
                &child,
                DACL_SECURITY_INFORMATION,
                sid,
                ACCESS_ALLOWED_ACE_TYPE
            )?);
            let mut integrity = RollbackStack::new();
            integrity.push(IntegrityGrant::install(&child)?);
            integrity.push(IntegrityGrant::install(&directory)?);
            // This pre-existing file gets no direct label mutation; only root
            // inheritance can establish the low label while the anchor is held.
            assert!(has_sid(
                &inherited_child,
                LABEL_SECURITY_INFORMATION,
                low,
                SYSTEM_MANDATORY_LABEL_ACE_TYPE
            )?);
            assert!(has_sid(
                &child,
                LABEL_SECURITY_INFORMATION,
                low,
                SYSTEM_MANDATORY_LABEL_ACE_TYPE
            )?);
            let mut grants = RollbackStack::new();
            grants.push(AclGrant::install(
                &directory,
                sid,
                ResourceAccess::WritableRoot,
            )?);
            assert!(has_sid(
                &child,
                DACL_SECURITY_INFORMATION,
                sid,
                ACCESS_ALLOWED_ACE_TYPE
            )?);
            // A host create is a mechanism check here; LPAC guest writes are
            // separately exercised by the native workspace conformance test.
            let added = format!("{directory}\\new-child");
            fs::write(&added, "new")?;
            assert!(has_sid(
                &added,
                DACL_SECURITY_INFORMATION,
                sid,
                ACCESS_ALLOWED_ACE_TYPE
            )?);
            drop(grants);
            assert!(!has_sid(
                &child,
                DACL_SECURITY_INFORMATION,
                sid,
                ACCESS_ALLOWED_ACE_TYPE
            )?);
            assert!(!has_sid(
                &added,
                DACL_SECURITY_INFORMATION,
                sid,
                ACCESS_ALLOWED_ACE_TYPE
            )?);
            drop(integrity);
            assert_eq!(
                security_snapshot(&directory, DACL_SECURITY_INFORMATION)?,
                original_root_acl
            );
            assert_eq!(
                security_snapshot(&child, DACL_SECURITY_INFORMATION)?,
                original_child_acl
            );
            assert_eq!(
                security_snapshot(&directory, LABEL_SECURITY_INFORMATION)?,
                original_root_label
            );
            assert_eq!(
                security_snapshot(&child, LABEL_SECURITY_INFORMATION)?,
                original_child_label
            );
            assert_eq!(
                security_snapshot(&inherited_child, LABEL_SECURITY_INFORMATION)?,
                original_inherited_label
            );
        }
        Ok(())
    }

    #[test]
    fn environment_is_sorted_case_insensitively_and_owner_coordinates_win() {
        let environment = BTreeMap::from([
            ("z_last".into(), "unicode: café".into()),
            ("Path".into(), "C:\\runtime".into()),
            ("home".into(), "C:\\host-home".into()),
            ("systemroot".into(), "C:\\forged-system".into()),
            ("userprofile".into(), "C:\\host-profile".into()),
            ("A_FIRST".into(), "value=with=equals".into()),
        ]);
        let block = environment_block(&environment, "C:\\private", "C:\\Windows").unwrap();
        assert_eq!(
            String::from_utf16(&block).unwrap(),
            concat!(
                "A_FIRST=value=with=equals\0",
                "HOME=C:\\private\0",
                "PATH=C:\\runtime\0",
                "SYSTEMROOT=C:\\Windows\0",
                "USERPROFILE=C:\\private\0",
                "Z_LAST=unicode: café\0\0"
            )
        );
    }

    #[test]
    fn environment_rejects_ambiguous_names_and_embedded_entries() {
        let duplicate = BTreeMap::from([
            ("PATH".into(), "first".into()),
            ("Path".into(), "second".into()),
        ]);
        assert!(environment_block(&duplicate, "home", "system").is_err());
        for (key, value) in [
            ("", "value"),
            ("=C:", "value"),
            ("KEY=OTHER", "value"),
            ("HÖME", "value"),
            ("KEY", "one\0OTHER=two"),
        ] {
            assert!(
                environment_block(
                    &BTreeMap::from([(key.into(), value.into())]),
                    "home",
                    "system"
                )
                .is_err()
            );
        }
    }

    #[test]
    fn job_retirement_observes_empty_and_bounds_stuck_descendants() {
        assert!(wait_for_empty_job(|| Ok(0), Instant::now()).is_ok());
        let mut queries = 0;
        let result = wait_for_empty_job(
            || {
                queries += 1;
                Ok(1)
            },
            Instant::now(),
        );
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("descendant exit is unconfirmed")
        );
        assert_eq!(queries, 1);
        assert!(
            wait_for_empty_job(
                || Err("accounting query failed".into()),
                Instant::now() + Duration::from_secs(1)
            )
            .is_err()
        );
    }
}
