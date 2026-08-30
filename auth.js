/* ==========================================================================
   Shared admin authentication — used by index.html and admin.html.

   The admin password is NOT in this codebase. It belongs to a Firebase
   Authentication account, so Google's servers verify it and the browser only
   ever learns whether the attempt succeeded. A successful sign-in also has to
   be listed under /admins/<uid> in the database, and the database security
   rules (see database.rules.json) grant admin-only writes to exactly those
   uids — so admin powers are enforced server side, not by this file.

   Setup steps live in SECURITY-SETUP.md.
   ========================================================================== */

/* The account that holds the admin password. Not a secret — the password is.
   Change it here if you create the Firebase account under another address. */
const ADMIN_EMAIL = 'admin@chatcreate.app';

/* Signs in with the typed password and confirms the account is an admin.
   Resolves with the Firebase user, or throws an Error with a message safe to
   show on screen. */
async function signInAsAdmin(password) {
    if (!password) {
        throw new Error('Enter the admin password.');
    }

    let credential;
    try {
        credential = await firebase.auth().signInWithEmailAndPassword(ADMIN_EMAIL, password);
    } catch (error) {
        throw new Error(describeAuthError(error));
    }

    const uid = credential.user.uid;
    let snapshot;
    try {
        snapshot = await firebase.database().ref('admins/' + uid).once('value');
    } catch (error) {
        await signOutAdmin();
        console.error('Could not read /admins/' + uid, error);
        throw new Error('Signed in, but the admin check was blocked by the database rules. UID: ' + uid);
    }

    if (!snapshot.exists()) {
        await signOutAdmin();
        throw new Error('Password accepted, but this account is not listed under /admins. Add this UID there: ' + uid);
    }

    return credential.user;
}

/* True while a signed-in admin session exists (survives page reloads). */
function currentAdminUser() {
    return firebase.auth().currentUser;
}

/* Confirms a restored session still belongs to an admin. */
async function isRegisteredAdmin(user) {
    if (!user) {
        return false;
    }
    const snapshot = await firebase.database().ref('admins/' + user.uid).once('value');
    return snapshot.exists();
}

function signOutAdmin() {
    return firebase.auth().signOut().catch((error) => {
        console.error('Sign-out failed:', error);
    });
}

/* Firebase error codes are not user-facing; translate the ones we expect.
   Wrong password and unknown account deliberately share one message so the
   form does not reveal whether the admin account exists. */
function describeAuthError(error) {
    switch (error && error.code) {
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
        case 'auth/invalid-login-credentials':
        case 'auth/user-not-found':
        case 'auth/invalid-email':
            return 'Invalid admin password.';
        case 'auth/too-many-requests':
            return 'Too many failed attempts. Wait a few minutes and try again.';
        case 'auth/network-request-failed':
            return 'Network error — check your connection and try again.';
        case 'auth/operation-not-allowed':
            return 'Email/Password sign-in is turned off for this Firebase project. See SECURITY-SETUP.md.';
        case 'auth/user-disabled':
            return 'That admin account has been disabled.';
        default:
            console.error('Admin sign-in failed:', error);
            return 'Could not sign in. Please try again.';
    }
}
