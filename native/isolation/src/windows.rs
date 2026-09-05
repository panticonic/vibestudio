use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::c_void,
    fs, io,
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
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
struct OwnedJob {
    handle: Handle,
    retired: bool,
}
impl OwnedJob {
    fn retire(&mut self) -> Result<()> {
        if self.retired {
            return Ok(());
        }
        unsafe {
            check(TerminateJobObject(self.handle.0, 125))?;
            loop {
                let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
                check(QueryInformationJobObject(
                    self.handle.0,
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                    null_mut(),
                ))?;
                if accounting.ActiveProcesses == 0 {
                    break;
                }
                Sleep(10);
            }
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
            status(SetSecurityInfo(
                object.0,
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                acl,
            ))?;
            Ok(Self {
                object,
                descriptor,
                original,
                persistent: false,
            })
        }
    }
}
impl Drop for IntegrityGrant {
    fn drop(&mut self) {
        if self.persistent {
            return;
        }
        unsafe {
            if SetKernelObjectSecurity(self.object.0, LABEL_SECURITY_INFORMATION, self.descriptor.0)
                == 0
            {
                eprintln!(
                    "Cannot restore retired private-state integrity label: {}",
                    io::Error::last_os_error()
                );
            }
        }
    }
}
impl AclGrant {
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
            status(SetSecurityInfo(
                object.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                updated,
                null_mut(),
            ))?;
            Ok(Self {
                object,
                descriptor,
                original,
                persistent: false,
            })
        }
    }
}
impl Drop for AclGrant {
    fn drop(&mut self) {
        if self.persistent {
            return;
        }
        unsafe {
            // Restore the pinned object, never a pathname that guest code could
            // have replaced. Kernel-object mutation does not walk a changed tree.
            if SetKernelObjectSecurity(self.object.0, DACL_SECURITY_INFORMATION, self.descriptor.0)
                == 0
            {
                eprintln!(
                    "Cannot restore retired private-state ACL: {}",
                    io::Error::last_os_error()
                );
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
        let mut integrity = Vec::new();
        let mut storage_grants = Vec::new();
        if fresh {
            // Only first provisioning sees a host-prepared, link-free tree.
            // Never walk or rewrite security on guest-controlled descendants at restart.
            let writable_tree = p
                .write
                .iter()
                .map(|resource| staged_tree(resource))
                .collect::<Result<Vec<_>>>()?;
            for tree in &writable_tree {
                for resource in tree {
                    integrity.push(IntegrityGrant::install(resource)?);
                }
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
            for grant in &mut storage_grants {
                grant.persistent = true;
            }
            for grant in &mut integrity {
                grant.persistent = true;
            }
        }
        // Committed storage security no longer needs rollback descriptors or
        // per-file handles. Only immutable anchors are pinned for the lifetime.
        drop(storage_grants);
        drop(integrity);
        let mut grants = Vec::new();
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
        let mut environment = p.environment;
        for (key, value) in &environment {
            if key.contains(['=', '\0']) || value.contains('\0') {
                return Err("Invalid environment entry".into());
            }
        }
        // The caller supplies a closed environment, including the private home.
        // It cannot smuggle inherited native helper handles through environment.
        environment.insert("HOME".into(), p.home.clone());
        environment.insert("USERPROFILE".into(), p.home.clone());
        let mut system = vec![0u16; 32768];
        let length = GetWindowsDirectoryW(system.as_mut_ptr(), system.len() as u32);
        if length == 0 || length as usize >= system.len() {
            return Err("Cannot resolve Windows runtime directory".into());
        }
        environment.insert(
            "SystemRoot".into(),
            String::from_utf16(&system[..length as usize])?,
        );
        let mut block = Vec::new();
        for (key, value) in environment {
            block.extend(wide(&format!("{key}={value}")));
        }
        block.push(0);
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
    use super::quote;
    #[test]
    fn command_line_preserves_empty_quotes_and_trailing_slashes() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("two words"), "\"two words\"");
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote("C:\\dir\\"), "\"C:\\dir\\\\\"");
    }
}
