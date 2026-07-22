import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
        import { firebaseConfig, appDataId, adminEmail } from "./firebase-config.js";
        import { getAuth, signInAnonymously, signInWithCustomToken, signInWithEmailAndPassword, updatePassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
        import { getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, writeBatch, collection, onSnapshot, query, where, orderBy, limit, getDocs } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

        const appId = appDataId;

        const app = initializeApp(firebaseConfig);
        const auth = getAuth(app);
        const db = getFirestore(app);

        let currentUserRole = null;
        let currentStudentProfile = null;
        let examTimerInterval = null;
        let globalRosterMap = {};
        let globalSubmissionsMap = {};
        let mediaPlayTracker = {};
        let stopExamListener = null;
        let sessionRestored = false;
        let examInProgress = false;
        window.activeAudioInstances = {};

        function studentLockdownActive() {
            return currentUserRole === 'student';
        }

        document.addEventListener('contextmenu', event => {
            if (studentLockdownActive()) event.preventDefault();
        }, true);

        for (const blockedEvent of ['copy', 'cut', 'paste', 'dragstart', 'drop']) {
            document.addEventListener(blockedEvent, event => {
                if (studentLockdownActive()) event.preventDefault();
            }, true);
        }

        document.addEventListener('keydown', event => {
            if (!studentLockdownActive()) return;
            const key = event.key.toLocaleLowerCase();
            const blockedShortcut = event.key === 'F12'
                || (event.ctrlKey && event.shiftKey && ['i', 'j', 'c'].includes(key))
                || (event.ctrlKey && ['u', 's', 'p'].includes(key))
                || (examInProgress && (event.key === 'F5' || (event.ctrlKey && ['r', 'l'].includes(key))));
            if (blockedShortcut) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);

        window.addEventListener('beforeunload', event => {
            if (!examInProgress) return;
            event.preventDefault();
            event.returnValue = '';
        });

        document.addEventListener('visibilitychange', () => {
            if (examInProgress && document.hidden) {
                sessionStorage.setItem('akyabExamLastHiddenAt', new Date().toISOString());
            }
        });

        document.addEventListener('input', event => {
            if (!examInProgress || !event.target.closest('#form-candidate-answers')) return;
            const state = JSON.parse(localStorage.getItem('akyabExamState') || 'null');
            if (!state) return;
            state.answers = Object.fromEntries(new FormData(document.getElementById('form-candidate-answers')).entries());
            localStorage.setItem('akyabExamState', JSON.stringify(state));
        });

        window.currentExamData = {
            title: "Akyab Institute Batch-9 Official Entrance Examination",
            timeLimitMinutes: 180,
            instructions: "Answer all sections completely. Audio/video media playback is limited to configured attempts.",
            sections: [
                {
                    sectionKey: "sec_0",
                    title: "Section 1: Listening Comprehension",
                    instructions: "Listen to the audio track carefully before answering Part 1 and Part 2 questions.",
                    passageTitle: "Audio Context Instructions",
                    passageText: "Listen attentively to the audio track. You may replay the track according to the specified limit.",
                    mediaUrl: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
                    maxPlays: 2,
                    parts: [
                        {
                            partTitle: "Part 1: Short Conversation MCQs",
                            items: [
                                {
                                    questionText: "1. What is the main topic discussed in the dialogue?",
                                    type: "mcq",
                                    options: ["(a) University Admission Criteria", "(b) Weather Forecast", "(c) Library Rules", "(d) Transportation Fees"],
                                    correctOption: "(a) University Admission Criteria",
                                    points: 2
                                },
                                {
                                    questionText: "2. Listen to the statements and verify True or False:",
                                    type: "tf",
                                    subItems: ["(1) The candidate completed application form.", "(2) Entrance fees are non-refundable."],
                                    correctSubAnswers: ["True", "False"],
                                    points: 2
                                }
                            ]
                        }
                    ]
                },
                {
                    sectionKey: "sec_1",
                    title: "Section 2: Reading Comprehension & Vocabulary",
                    instructions: "Read the passage carefully and complete all questions below.",
                    passageTitle: "The Modern Educational Evolution",
                    passageText: "Modern education has undergone significant transformations over the past decade. Digital literacy, critical thinking, and collaborative problem-solving have emerged as foundational pillars for academic success. Higher education institutions now prioritize interactive and practical learning methodologies over pure memorization.",
                    mediaUrl: "",
                    maxPlays: 0,
                    parts: [
                        {
                            partTitle: "Part 1: Passage Comprehension Questions",
                            items: [
                                {
                                    questionText: "1. What are the three foundational pillars for academic success mentioned in the passage?",
                                    type: "mcq",
                                    options: ["(a) Memorization, Speed, and Fees", "(b) Digital literacy, critical thinking, and collaborative problem-solving", "(c) Attendance, Sports, and Writing"],
                                    correctOption: "(b) Digital literacy, critical thinking, and collaborative problem-solving",
                                    points: 3
                                }
                            ]
                        }
                    ]
                },
                {
                    sectionKey: "sec_2",
                    title: "Section 3: Essay & Academic Writing",
                    instructions: "Write a comprehensive essay response. Punctuation (. , ? !) will be excluded from the live word count.",
                    passageTitle: "Essay Topic Prompt",
                    passageText: "Discuss the impact of technology on modern learning environments.",
                    mediaUrl: "",
                    maxPlays: 0,
                    parts: [
                        {
                            partTitle: "Part 1: Analytical Response Essay",
                            items: [
                                {
                                    questionText: "1. Write an essay evaluating how digital tools enhance student critical thinking skills.",
                                    type: "essay",
                                    points: 10
                                }
                            ]
                        }
                    ]
                }
            ]
        };

        function getCleanWordCount(text) {
            if (!text) return 0;
            const cleanText = text.replace(/[.,?!;:'"()\[\]{}\-–—]/g, ' ');
            const words = cleanText.trim().split(/\s+/).filter(Boolean);
            return words.length;
        }
        window.getCleanWordCount = getCleanWordCount;

        function escapeHtml(value) {
            return String(value ?? '')
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;')
                .replaceAll('"', '&quot;')
                .replaceAll("'", '&#039;');
        }

        async function initAuth() {
            try {
                await auth.authStateReady();
                if (auth.currentUser) return;
                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    await signInWithCustomToken(auth, __initial_auth_token);
                } else {
                    await signInAnonymously(auth);
                }
            } catch (err) {
                console.error("Auth init error:", err);
            }
        }

        onAuthStateChanged(auth, (user) => {
            if (user) {
                console.log("Firebase authenticated successfully:", user.uid);
                listenToFirestoreData();
                if (currentUserRole === 'admin') loadRosterData();
                restorePortalSession();
            }
        });
        initAuth();

        function listenToFirestoreData() {
            if (!auth.currentUser) return;

            const examRef = doc(db, 'artifacts', appId, 'public', 'data', 'exam_papers', 'current_exam');
            if (stopExamListener) stopExamListener();
            stopExamListener = onSnapshot(examRef, (docSnap) => {
                if (docSnap.exists()) {
                    window.currentExamData = docSnap.data();
                    if (currentUserRole === 'admin') {
                        window.renderExamBuilder();
                    }
                }
            }, (err) => console.error("Exam paper snapshot error:", err));

        }

        async function loadRosterData() {
            if (!auth.currentUser || currentUserRole !== 'admin') return;
            try {
                const snapshot = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'student_roster'));
                globalRosterMap = {};
                snapshot.forEach(item => globalRosterMap[item.id] = item.data());
                renderRosterTable();
            } catch (err) {
                console.error("Roster load error:", err);
            }
        }

        async function loadRecentSubmissions() {
            if (!auth.currentUser || currentUserRole !== 'admin') return;
            try {
                const subsRef = collection(db, 'artifacts', appId, 'public', 'data', 'exam_submissions');
                const snapshot = await getDocs(query(subsRef, orderBy('submittedAt', 'desc'), limit(25)));
                globalSubmissionsMap = {};
                snapshot.forEach(item => {
                    const data = item.data();
                    globalSubmissionsMap[item.id] = {
                        ...data,
                        _docId: item.id,
                        submissionId: data.submissionId || item.id,
                        studentId: data.studentId || data.studentID || data.candidateId || data.candidateID || item.id.split('_')[0],
                        studentName: data.studentName || data.candidateName || data.name || data.student_name || 'Unknown Candidate',
                        submittedAt: data.submittedAt || data.submissionTime || data.timestamp || data.createdAt || null,
                        answers: data.answers || data.responses || data.studentAnswers || {},
                        autoScore: data.autoScore ?? data.objectiveScore ?? data.score ?? 0,
                        totalObjectivePossible: data.totalObjectivePossible ?? data.totalPossible ?? data.totalScore ?? 0
                    };
                });
                renderSubmissionsTable();
                await Promise.allSettled(Object.values(globalSubmissionsMap).map(async sub => {
                    if (!sub.studentId) return;
                    const statusRef = doc(db, 'artifacts', appId, 'public', 'data', 'exam_submission_status', sub.studentId);
                    const statusDoc = await getDoc(statusRef);
                    if (!statusDoc.exists()) {
                        await setDoc(statusRef, {
                            studentId: sub.studentId,
                            ownerUid: sub.ownerUid || 'legacy-submission',
                            submissionId: sub._docId || sub.submissionId,
                            submittedAt: sub.submittedAt || new Date().toISOString()
                        });
                    }
                }));
            } catch (err) {
                console.error("Submissions load error:", err);
            }
        }

        window.setAuthRole = function(role) {
            const btnStudent = document.getElementById('btn-role-student');
            const btnAdmin = document.getElementById('btn-role-admin');
            const formStudent = document.getElementById('form-student-login');
            const formAdmin = document.getElementById('form-admin-login');

            if (role === 'student') {
                btnStudent.className = "flex-1 py-2 text-xs font-bold rounded-lg bg-white text-brand-700 shadow-sm transition-all";
                btnAdmin.className = "flex-1 py-2 text-xs font-bold rounded-lg text-slate-600 hover:text-slate-900 transition-all";
                formStudent.classList.remove('hidden');
                formAdmin.classList.add('hidden');
            } else {
                btnAdmin.className = "flex-1 py-2 text-xs font-bold rounded-lg bg-white text-brand-700 shadow-sm transition-all";
                btnStudent.className = "flex-1 py-2 text-xs font-bold rounded-lg text-slate-600 hover:text-slate-900 transition-all";
                formAdmin.classList.remove('hidden');
                formStudent.classList.add('hidden');
            }
        };

        window.quickFillStudent = function(id, name) {
            document.getElementById('input-student-id').value = id;
            document.getElementById('input-student-name').value = name;
        };

        async function restorePortalSession() {
            if (sessionRestored) return;
            sessionRestored = true;

            let savedSession;
            try {
                savedSession = JSON.parse(sessionStorage.getItem('akyabPortalSession') || 'null');
            } catch {
                sessionStorage.removeItem('akyabPortalSession');
                return;
            }
            if (!savedSession?.role) return;

            if (savedSession.role === 'admin') {
                if (auth.currentUser?.email?.toLocaleLowerCase() !== adminEmail.toLocaleLowerCase()) {
                    sessionStorage.removeItem('akyabPortalSession');
                    return;
                }
                currentUserRole = 'admin';
                document.getElementById('user-display-name').textContent = 'Administrator';
                document.getElementById('user-badge').classList.remove('hidden');
                document.getElementById('logout-btn').classList.remove('hidden');
                document.getElementById('view-auth').classList.add('hidden');
                document.getElementById('view-admin').classList.remove('hidden');
                loadRosterData();
                window.renderExamBuilder();
                return;
            }

            if (savedSession.role === 'student' && savedSession.studentId) {
                try {
                    const rosterDoc = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'student_roster', savedSession.studentId));
                    if (!rosterDoc.exists()) throw new Error('Student is no longer registered.');
                    const registeredName = String(rosterDoc.data().studentName || '').trim();
                    currentUserRole = 'student';
                    currentStudentProfile = { studentId: savedSession.studentId, studentName: registeredName };
                    document.getElementById('user-display-name').textContent = `${registeredName} (${savedSession.studentId})`;
                    document.getElementById('user-badge').classList.remove('hidden');
                    document.getElementById('logout-btn').classList.remove('hidden');
                    document.getElementById('view-auth').classList.add('hidden');
                    document.getElementById('view-student').classList.remove('hidden');
                    document.getElementById('student-portal-name').textContent = `Welcome, ${registeredName}`;
                    document.getElementById('student-portal-id').textContent = `Student ID: ${savedSession.studentId}`;
                    await checkExistingStudentSubmission(savedSession.studentId);
                } catch (err) {
                    sessionStorage.removeItem('akyabPortalSession');
                    console.warn('Student session restore failed:', err);
                }
            }
        }

        window.handleStudentLogin = async function(e) {
            e.preventDefault();
            const sid = document.getElementById('input-student-id').value.trim().toUpperCase();
            const sname = document.getElementById('input-student-name').value.trim();
            const loginBtn = document.getElementById('btn-student-login-submit');

            if (!sid || !sname) return;

            loginBtn.disabled = true;
            loginBtn.classList.add('opacity-60', 'cursor-wait');
            loginBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>Checking student record...</span>`;

            try {
                if (!auth.currentUser) await initAuth();

                const rosterDoc = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'student_roster', sid));
                if (!rosterDoc.exists()) {
                    window.showModal("Login Denied", `Student ID ${sid} is not registered in the approved candidate database.`);
                    return;
                }

                const rosterStudent = rosterDoc.data();
                const registeredName = String(rosterStudent.studentName || '').trim();
                const normalizeName = value => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

                if (!registeredName || normalizeName(sname) !== normalizeName(registeredName)) {
                    window.showModal("Login Denied", "The candidate name does not match the name registered for this Student ID.");
                    return;
                }

                currentUserRole = 'student';
                currentStudentProfile = { studentId: sid, studentName: registeredName };
                sessionStorage.setItem('akyabPortalSession', JSON.stringify({ role: 'student', studentId: sid }));

                document.getElementById('user-display-name').textContent = `${registeredName} (${sid})`;
                document.getElementById('user-badge').classList.remove('hidden');
                document.getElementById('logout-btn').classList.remove('hidden');

                document.getElementById('view-auth').classList.add('hidden');
                document.getElementById('view-student').classList.remove('hidden');

                document.getElementById('student-portal-name').textContent = `Welcome, ${registeredName}`;
                document.getElementById('student-portal-id').textContent = `Student ID: ${sid}`;

                await checkExistingStudentSubmission(sid);
            } catch (err) {
                console.error("Student login verification error:", err);
                window.showModal("Login Error", `Could not verify the student database: ${err.message || err}`);
            } finally {
                loginBtn.disabled = false;
                loginBtn.classList.remove('opacity-60', 'cursor-wait');
                loginBtn.innerHTML = `<span>Access Student Gate</span> <i class="fa-solid fa-arrow-right"></i>`;
            }
        };

        window.handleAdminLogin = async function(e) {
            e.preventDefault();
            const email = document.getElementById('input-admin-user').value.trim().toLocaleLowerCase();
            const pass = document.getElementById('input-admin-pass').value.trim();

            if (email !== adminEmail.toLocaleLowerCase()) {
                window.showModal("Access Denied", "Invalid administrator credentials.");
                return;
            }

            try {
                const credential = await signInWithEmailAndPassword(auth, email, pass);
                if (credential.user.email?.toLocaleLowerCase() !== adminEmail.toLocaleLowerCase()) {
                    await signOut(auth);
                    throw new Error('This account is not authorized as administrator.');
                }
                currentUserRole = 'admin';
                sessionStorage.setItem('akyabPortalSession', JSON.stringify({ role: 'admin' }));
                document.getElementById('user-display-name').textContent = 'Administrator';
                document.getElementById('user-badge').classList.remove('hidden');
                document.getElementById('logout-btn').classList.remove('hidden');

                document.getElementById('view-auth').classList.add('hidden');
                document.getElementById('view-admin').classList.remove('hidden');
                loadRosterData();
                window.renderExamBuilder();
            } catch (err) {
                console.error("Admin authentication error:", err);
                window.showModal("Access Denied", "Invalid Admin Username or Password.");
            }
        };

        window.handleLogout = async function() {
            currentUserRole = null;
            currentStudentProfile = null;
            examInProgress = false;
            sessionStorage.removeItem('akyabPortalSession');
            if (examTimerInterval) clearInterval(examTimerInterval);
            window.stopAllAudioInstances();
            globalRosterMap = {};
            globalSubmissionsMap = {};

            document.getElementById('user-badge').classList.add('hidden');
            document.getElementById('logout-btn').classList.add('hidden');

            document.getElementById('view-auth').classList.remove('hidden');
            document.getElementById('view-student').classList.add('hidden');
            document.getElementById('view-admin').classList.add('hidden');
            document.getElementById('exam-paper-container').classList.add('hidden');
            try {
                await signOut(auth);
                await signInAnonymously(auth);
            } catch (err) {
                console.warn("Logout authentication reset error:", err);
            }
        };

        async function checkExistingStudentSubmission(sid) {
            const startGate = document.getElementById('exam-start-gate');
            const submittedBanner = document.getElementById('already-submitted-banner');
            const startBtn = document.getElementById('btn-start-exam');
            document.getElementById('exam-paper-container').classList.add('hidden');
            startGate.classList.remove('hidden');

            let existing;
            try {
                const statusRef = doc(db, 'artifacts', appId, 'public', 'data', 'exam_submission_status', sid);
                const statusDoc = await getDoc(statusRef);
                existing = statusDoc.exists();
            } catch (err) {
                console.warn("Student submission check error:", err);
            }

            if (existing) {
                startGate.classList.add('opacity-60');
                startBtn.disabled = true;
                startBtn.innerHTML = `<i class="fa-solid fa-lock"></i> <span>🔒 Examination Already Completed</span>`;
                startBtn.className = "px-8 py-3.5 bg-slate-600 text-slate-300 font-bold rounded-xl cursor-not-allowed text-sm shrink-0 flex items-center gap-2";
                submittedBanner.classList.remove('hidden');
            } else {
                startGate.classList.remove('opacity-60');
                startBtn.disabled = false;
                startBtn.innerHTML = `<i class="fa-solid fa-play"></i> <span>Start Examination Now & Begin Timer</span>`;
                startBtn.className = "px-8 py-3.5 bg-emerald-500 hover:bg-emerald-600 text-white font-extrabold rounded-xl shadow-lg shadow-emerald-500/30 text-sm transition-all transform active:scale-95 shrink-0 flex items-center gap-2";
                submittedBanner.classList.add('hidden');
                try {
                    const state = JSON.parse(localStorage.getItem('akyabExamState') || 'null');
                    if (state?.studentId === sid) window.startCandidateExam(true);
                } catch {
                    localStorage.removeItem('akyabExamState');
                }
            }
        }

        window.startCandidateExam = function(resume = false) {
            examInProgress = true;
            let state;
            try {
                state = JSON.parse(localStorage.getItem('akyabExamState') || 'null');
            } catch {
                localStorage.removeItem('akyabExamState');
            }
            if (!resume || !state || state.studentId !== currentStudentProfile.studentId) {
                const durationMs = (window.currentExamData.timeLimitMinutes || 180) * 60 * 1000;
                state = {
                    studentId: currentStudentProfile.studentId,
                    startedAt: Date.now(),
                    endsAt: Date.now() + durationMs,
                    answers: {}
                };
                localStorage.setItem('akyabExamState', JSON.stringify(state));
            }
            document.getElementById('exam-start-gate').classList.add('hidden');
            document.getElementById('exam-paper-container').classList.remove('hidden');

            renderCandidateExamPaper();

            for (const [name, value] of Object.entries(state.answers || {})) {
                document.querySelectorAll(`[name="${CSS.escape(name)}"]`).forEach(field => {
                    if (field.type === 'radio') field.checked = field.value === value;
                    else field.value = value;
                });
            }

            let durationSeconds = Math.max(0, Math.ceil((state.endsAt - Date.now()) / 1000));
            const timerDisplay = document.getElementById('timer-display');
            const timerSub = document.getElementById('timer-status-sub');
            timerSub.textContent = "Exam in progress...";

            if (examTimerInterval) clearInterval(examTimerInterval);

            if (durationSeconds <= 0) {
                timerDisplay.textContent = "00:00:00";
                setTimeout(() => window.submitCandidateAnswersAuto(), 0);
                return;
            }

            examTimerInterval = setInterval(() => {
                durationSeconds--;

                if (durationSeconds <= 0) {
                    clearInterval(examTimerInterval);
                    timerDisplay.textContent = "00:00:00";
                    window.showModal("Time Expired", "The 3-hour examination duration has ended. Your answers will now be submitted automatically.");
                    window.submitCandidateAnswersAuto();
                    return;
                }

                const hrs = Math.floor(durationSeconds / 3600);
                const mins = Math.floor((durationSeconds % 3600) / 60);
                const secs = durationSeconds % 60;

                timerDisplay.textContent = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
            }, 1000);
        };

        function renderCandidateExamPaper() {
            const container = document.getElementById('exam-sections-render');
            if (!window.currentExamData || !window.currentExamData.sections) {
                container.innerHTML = `<p class="text-center text-slate-500">No exam sections available.</p>`;
                return;
            }

            container.innerHTML = window.currentExamData.sections.map((sec, sIdx) => {
                let mediaHTML = '';
                if (sec.mediaUrl) {
                    const playsLeft = sec.maxPlays ? (sec.maxPlays - (mediaPlayTracker[sec.sectionKey] || 0)) : 'Unlimited';
                    mediaHTML = `
                        <div class="bg-indigo-50/80 p-4 rounded-xl border border-indigo-100 flex flex-col sm:flex-row items-center justify-between gap-3">
                            <div class="flex items-center gap-3">
                                <div class="w-10 h-10 bg-indigo-600 text-white rounded-xl flex items-center justify-center font-bold">
                                    <i class="fa-solid fa-headphones"></i>
                                </div>
                                <div>
                                    <p class="text-xs font-bold text-indigo-900">Listening Track Media</p>
                                    <p class="text-[11px] text-indigo-600">Plays remaining: <strong id="play-count-${sec.sectionKey}">${playsLeft}</strong></p>
                                </div>
                            </div>
                            <div class="flex items-center gap-2">
                                <button type="button" onclick="playAudioMedia('${sec.sectionKey}', '${sec.mediaUrl}', ${sec.maxPlays || 999})" class="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold rounded-lg shadow-sm transition-all flex items-center gap-1.5">
                                    <i class="fa-solid fa-play"></i> Play
                                </button>
                                <button type="button" onclick="pauseAudioMedia('${sec.sectionKey}')" class="px-3.5 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold rounded-lg shadow-sm transition-all flex items-center gap-1.5">
                                    <i class="fa-solid fa-pause"></i> Pause
                                </button>
                            </div>
                        </div>
                    `;
                }

                let passageHTML = '';
                if (sec.passageTitle || sec.passageText) {
                    passageHTML = `
                        <div class="bg-slate-50 p-5 rounded-xl border border-slate-200 space-y-2">
                            <h4 class="text-xs font-bold text-slate-800 uppercase tracking-wider">${sec.passageTitle || 'Reading Passage'}</h4>
                            <p class="text-xs text-slate-600 leading-relaxed whitespace-pre-line">${sec.passageText || ''}</p>
                            ${mediaHTML}
                        </div>
                    `;
                } else if (mediaHTML) {
                    passageHTML = `<div class="p-2">${mediaHTML}</div>`;
                }

                let partsHTML = '';
                if (sec.parts) {
                    partsHTML = sec.parts.map((part, pIdx) => {
                        let itemsHTML = '';
                        if (part.items) {
                            itemsHTML = part.items.map((item, qIdx) => {
                                const qName = `q_${sIdx}_${pIdx}_${qIdx}`;
                                
                                if (item.type === 'mcq') {
                                    let optionsHTML = '';
                                    if (item.options) {
                                        optionsHTML = item.options.map(opt => `
                                            <label class="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer text-xs transition-all">
                                                <input type="radio" name="${qName}" value="${opt}" ${item.required !== false ? 'required' : ''} class="text-brand-600 focus:ring-brand-500">
                                                <span class="font-medium text-slate-700">${opt}</span>
                                            </label>
                                        `).join('');
                                    }
                                    return `
                                        <div class="bg-white p-4 rounded-xl border border-slate-200 space-y-3 shadow-sm">
                                            <p class="text-xs font-bold text-slate-900">${item.questionText} <span class="text-brand-600 font-semibold">[${item.points || 1} Marks]</span></p>
                                            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">${optionsHTML}</div>
                                        </div>
                                    `;
                                } else if (item.type === 'short') {
                                    return `
                                        <div class="bg-white p-4 rounded-xl border border-slate-200 space-y-3 shadow-sm">
                                            <p class="text-xs font-bold text-slate-900">${item.questionText} <span class="text-brand-600 font-semibold">[${item.points || 1} Marks]</span></p>
                                            <input type="text" name="${qName}" ${item.required !== false ? 'required' : ''} placeholder="Type your short answer" class="w-full p-3 border rounded-xl text-xs focus:ring-2 focus:ring-brand-500">
                                        </div>`;
                                } else if (item.type === 'tf') {
                                    if (!item.subItems || item.subItems.length === 0) {
                                        return `
                                            <div class="bg-white p-4 rounded-xl border border-slate-200 space-y-3 shadow-sm">
                                                <p class="text-xs font-bold text-slate-900">${item.questionText} <span class="text-brand-600 font-semibold">[${item.points || 1} Marks]</span></p>
                                                <div class="flex gap-5">
                                                    <label class="flex items-center gap-2 text-xs font-semibold cursor-pointer"><input type="radio" name="${qName}" value="True" ${item.required !== false ? 'required' : ''} class="text-brand-600"> True</label>
                                                    <label class="flex items-center gap-2 text-xs font-semibold cursor-pointer"><input type="radio" name="${qName}" value="False" ${item.required !== false ? 'required' : ''} class="text-brand-600"> False</label>
                                                </div>
                                            </div>`;
                                    }
                                    let subItemsHTML = '';
                                    if (item.subItems) {
                                        subItemsHTML = item.subItems.map((subText, subIdx) => {
                                            const subName = `${qName}_sub_${subIdx}`;
                                            return `
                                                <div class="flex items-center justify-between p-2.5 bg-slate-50 rounded-lg border border-slate-200">
                                                    <span class="text-xs font-medium text-slate-700">${subText}</span>
                                                    <div class="flex items-center gap-4">
                                                        <label class="flex items-center gap-1.5 text-xs font-semibold cursor-pointer">
                                                            <input type="radio" name="${subName}" value="True" ${item.required !== false ? 'required' : ''} class="text-brand-600"> True
                                                        </label>
                                                        <label class="flex items-center gap-1.5 text-xs font-semibold cursor-pointer">
                                                            <input type="radio" name="${subName}" value="False" ${item.required !== false ? 'required' : ''} class="text-brand-600"> False
                                                        </label>
                                                    </div>
                                                </div>
                                            `;
                                        }).join('');
                                    }
                                    return `
                                        <div class="bg-white p-4 rounded-xl border border-slate-200 space-y-3 shadow-sm">
                                            <p class="text-xs font-bold text-slate-900">${item.questionText} <span class="text-brand-600 font-semibold">[${item.points || 2} Marks]</span></p>
                                            <div class="space-y-2">${subItemsHTML}</div>
                                        </div>
                                    `;
                                } else if (item.type === 'essay') {
                                    const wordCountId = `word_count_${sIdx}_${pIdx}_${qIdx}`;
                                    return `
                                        <div class="bg-white p-4 rounded-xl border border-slate-200 space-y-3 shadow-sm">
                                            <div class="flex justify-between items-center">
                                                <p class="text-xs font-bold text-slate-900">${item.questionText} <span class="text-brand-600 font-semibold">[${item.points || 10} Marks]</span></p>
                                                <span id="${wordCountId}" class="text-[11px] font-extrabold bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-md">0 words</span>
                                            </div>
                                            <textarea name="${qName}" rows="6" oninput="updateLiveWordCount(this, '${wordCountId}')" placeholder="Type your comprehensive essay response here..." ${item.required !== false ? 'required' : ''} class="w-full p-3 border rounded-xl text-xs focus:ring-2 focus:ring-brand-500"></textarea>
                                        </div>
                                    `;
                                }
                                return '';
                            }).join('');
                        }
                        return `
                            <div class="space-y-3">
                                <h5 class="text-xs font-extrabold text-slate-700 uppercase tracking-wider bg-slate-100 p-2.5 rounded-lg">${part.partTitle}</h5>
                                ${(part.passageTitle || part.passageText) ? `
                                    <div class="bg-amber-50/70 p-4 rounded-xl border border-amber-200 space-y-2">
                                        <h6 class="text-xs font-extrabold text-amber-900 uppercase tracking-wider">${part.passageTitle || 'Part Passage'}</h6>
                                        <p class="text-xs text-slate-700 leading-relaxed whitespace-pre-line">${part.passageText || ''}</p>
                                    </div>
                                ` : ''}
                                ${itemsHTML}
                            </div>
                        `;
                    }).join('');
                }

                return `
                    <div class="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-6">
                        <div class="border-b pb-3">
                            <span class="text-[10px] font-extrabold bg-brand-50 text-brand-700 px-2.5 py-1 rounded-md uppercase">Section ${sIdx + 1}</span>
                            <h3 class="text-base font-black text-slate-900 mt-1">${sec.title}</h3>
                            <p class="text-xs text-slate-500">${sec.instructions || ''}</p>
                        </div>
                        ${passageHTML}
                        ${partsHTML}
                    </div>
                `;
            }).join('');
        }

        window.updateLiveWordCount = function(textarea, displayId) {
            const count = getCleanWordCount(textarea.value);
            const target = document.getElementById(displayId);
            if (target) {
                target.textContent = `${count} words`;
            }
        };

        window.playAudioMedia = function(secKey, url, maxPlays) {
            if (window.activeAudioInstances[secKey]) {
                window.activeAudioInstances[secKey].play();
                window.showModal("Playing Audio", "Resuming listening track...");
                return;
            }

            const currentPlays = mediaPlayTracker[secKey] || 0;
            if (currentPlays >= maxPlays) {
                window.showModal("Limit Reached", "You have reached the maximum playback limit for this listening track.");
                return;
            }

            mediaPlayTracker[secKey] = currentPlays + 1;
            const targetBadge = document.getElementById(`play-count-${secKey}`);
            if (targetBadge) {
                targetBadge.textContent = maxPlays - mediaPlayTracker[secKey];
            }

            const audio = new Audio(url);
            window.activeAudioInstances[secKey] = audio;
            
            audio.onended = () => {
                delete window.activeAudioInstances[secKey];
            };

            audio.play().catch(err => {
                console.error("Audio playback error:", err);
            });
            window.showModal("Playing Audio", "Listening track playing...");
        };

        window.pauseAudioMedia = function(secKey) {
            if (window.activeAudioInstances[secKey]) {
                window.activeAudioInstances[secKey].pause();
                window.showModal("Audio Paused", "Listening track paused.");
            } else {
                window.showModal("Audio Info", "No audio track is currently playing for this section.");
            }
        };

        window.stopAllAudioInstances = function() {
            if (window.activeAudioInstances) {
                Object.values(window.activeAudioInstances).forEach(audio => {
                    try {
                        audio.pause();
                        audio.currentTime = 0;
                    } catch (e) {
                        console.error(e);
                    }
                });
                window.activeAudioInstances = {};
            }
        };

        window.submitCandidateAnswers = async function(e) {
            if (e) e.preventDefault();
            await window.submitCandidateAnswersAuto();
        };

        window.submitCandidateAnswersAuto = async function() {
            if (!currentStudentProfile) return;

            window.stopAllAudioInstances();
            if (examTimerInterval) clearInterval(examTimerInterval);

            const form = document.getElementById('form-candidate-answers');
            const formData = new FormData(form);
            const answersMap = {};
            for (let [k, v] of formData.entries()) {
                answersMap[k] = v;
            }

            let autoScore = 0;
            let totalObjectivePossible = 0;

            window.currentExamData.sections.forEach((sec, sIdx) => {
                if (sec.parts) {
                    sec.parts.forEach((part, pIdx) => {
                        if (part.items) {
                            part.items.forEach((item, qIdx) => {
                                const qName = `q_${sIdx}_${pIdx}_${qIdx}`;
                                const pts = item.points || 1;

                                if (item.type === 'mcq') {
                                    totalObjectivePossible += pts;
                                    if (answersMap[qName] === item.correctOption) {
                                        autoScore += pts;
                                    }
                                } else if (item.type === 'short') {
                                    totalObjectivePossible += pts;
                                    const normalizeAnswer = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
                                    if (normalizeAnswer(answersMap[qName]) && normalizeAnswer(answersMap[qName]) === normalizeAnswer(item.correctAnswer)) {
                                        autoScore += pts;
                                    }
                                } else if (item.type === 'tf') {
                                    if ((!item.subItems || item.subItems.length === 0) && item.correctAnswer) {
                                        totalObjectivePossible += pts;
                                        if (answersMap[qName] === item.correctAnswer) autoScore += pts;
                                    } else if (item.subItems && item.correctSubAnswers) {
                                        item.subItems.forEach((_, subIdx) => {
                                            const subName = `${qName}_sub_${subIdx}`;
                                            totalObjectivePossible += 1;
                                            if (answersMap[subName] === item.correctSubAnswers[subIdx]) {
                                                autoScore += 1;
                                            }
                                        });
                                    }
                                }
                            });
                        }
                    });
                }
            });

            const submissionId = `${currentStudentProfile.studentId}_${Date.now()}`;
            const submissionRecord = {
                submissionId: submissionId,
                ownerUid: auth.currentUser.uid,
                studentId: currentStudentProfile.studentId,
                studentName: currentStudentProfile.studentName,
                submittedAt: new Date().toISOString(),
                answers: answersMap,
                autoScore: autoScore,
                totalObjectivePossible: totalObjectivePossible,
                essayGraded: false,
                essayScore: 0,
                adminRemarks: ""
            };

            try {
                const batch = writeBatch(db);
                batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'exam_submissions', submissionId), submissionRecord);
                batch.set(doc(db, 'artifacts', appId, 'public', 'data', 'exam_submission_status', currentStudentProfile.studentId), {
                    studentId: currentStudentProfile.studentId,
                    ownerUid: auth.currentUser.uid,
                    submissionId: submissionId,
                    submittedAt: submissionRecord.submittedAt
                });
                await batch.commit();
                examInProgress = false;
                localStorage.removeItem('akyabExamState');
                window.showModal("Examination Submitted Successfully", `Your answers have been securely recorded. Objective Score: ${autoScore} / ${totalObjectivePossible}`);
                
                document.getElementById('exam-paper-container').classList.add('hidden');
                document.getElementById('exam-start-gate').classList.add('hidden');
                document.getElementById('already-submitted-banner').classList.remove('hidden');
            } catch (err) {
                console.error("Submission save error:", err);
                window.showModal("Submission Error", "Failed to save submission to cloud database. Please retry.");
                window.startCandidateExam(true);
            }
        };

        function renderStructuredSubmissionAnswers(sub) {
            if (!window.currentExamData || !window.currentExamData.sections) {
                let fallbackHtml = '';
                for (let [k, v] of Object.entries(sub.answers || {})) {
                    fallbackHtml += `<div class="p-2.5 bg-white border rounded-lg text-xs flex justify-between"><span class="font-semibold text-slate-600">${escapeHtml(k)}:</span> <span class="font-bold text-slate-900">${escapeHtml(v)}</span></div>`;
                }
                return fallbackHtml;
            }

            let html = '';
            window.currentExamData.sections.forEach((sec, sIdx) => {
                let partsHtml = '';
                if (sec.parts) {
                    sec.parts.forEach((part, pIdx) => {
                        let itemsHtml = '';
                        if (part.items) {
                            part.items.forEach((item, qIdx) => {
                                const qName = `q_${sIdx}_${pIdx}_${qIdx}`;
                                if (item.type === 'mcq' || item.type === 'short' || item.type === 'essay') {
                                    const ans = sub.answers[qName] ? escapeHtml(sub.answers[qName]) : '<span class="text-slate-400 italic">No Answer</span>';
                                    let isCorrectHTML = '';
                                    if (item.type === 'mcq') {
                                        const correct = item.correctOption;
                                        if (sub.answers[qName] === correct) {
                                            isCorrectHTML = `<span class="bg-emerald-100 text-emerald-800 text-[10px] font-extrabold px-2 py-0.5 rounded">Correct (+${item.points || 1})</span>`;
                                        } else {
                                            isCorrectHTML = `<span class="bg-rose-100 text-rose-800 text-[10px] font-extrabold px-2 py-0.5 rounded">Incorrect (Correct: ${correct})</span>`;
                                        }
                                    } else if (item.type === 'short') {
                                        const normalizedGiven = String(sub.answers[qName] || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
                                        const normalizedCorrect = String(item.correctAnswer || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
                                        isCorrectHTML = normalizedGiven === normalizedCorrect
                                            ? `<span class="bg-emerald-100 text-emerald-800 text-[10px] font-extrabold px-2 py-0.5 rounded">Correct (+${item.points || 1})</span>`
                                            : `<span class="bg-rose-100 text-rose-800 text-[10px] font-extrabold px-2 py-0.5 rounded">Incorrect (Correct: ${item.correctAnswer || ''})</span>`;
                                    } else if (item.type === 'essay') {
                                        const wordCount = getCleanWordCount(sub.answers[qName] || '');
                                        isCorrectHTML = `<span class="bg-indigo-100 text-indigo-800 text-[10px] font-extrabold px-2 py-0.5 rounded">${wordCount} words</span>`;
                                    }

                                    itemsHtml += `
                                        <div class="p-3 bg-white border rounded-xl space-y-1.5 shadow-sm">
                                            <div class="flex justify-between items-start gap-2">
                                                <p class="text-xs font-bold text-slate-900">${item.questionText}</p>
                                                ${isCorrectHTML}
                                            </div>
                                            <div class="text-xs text-slate-700 bg-slate-50 p-2.5 rounded-lg border border-slate-100">
                                                <span class="font-bold text-slate-500">Candidate Answer:</span> <span class="font-semibold text-slate-900">${ans}</span>
                                            </div>
                                        </div>
                                    `;
                                } else if (item.type === 'tf') {
                                    if (!item.subItems || item.subItems.length === 0) {
                                        const rawTfAnswer = sub.answers[qName] || 'No Answer';
                                        const tfAnswer = escapeHtml(rawTfAnswer);
                                        const tfCorrect = rawTfAnswer === item.correctAnswer;
                                        itemsHtml += `
                                            <div class="p-3 bg-white border rounded-xl space-y-2 shadow-sm">
                                                <div class="flex justify-between items-start gap-2"><p class="text-xs font-bold text-slate-900">${item.questionText}</p><span class="${tfCorrect ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'} text-[10px] font-extrabold px-2 py-0.5 rounded">${tfCorrect ? 'Correct' : `Incorrect (Correct: ${item.correctAnswer})`}</span></div>
                                                <p class="text-xs text-slate-700 bg-slate-50 p-2.5 rounded-lg">Answer: <strong>${tfAnswer}</strong></p>
                                            </div>`;
                                        return;
                                    }
                                    let subAnswersHtml = '';
                                    if (item.subItems) {
                                        item.subItems.forEach((subText, subIdx) => {
                                            const subName = `${qName}_sub_${subIdx}`;
                                            const subAnsRaw = sub.answers[subName] || 'No Answer';
                                            const subAns = escapeHtml(subAnsRaw);
                                            const correctSub = item.correctSubAnswers ? item.correctSubAnswers[subIdx] : '';
                                            const isSubCorrect = subAnsRaw === correctSub;
                                            const subBadge = isSubCorrect ? `<span class="text-emerald-700 font-extrabold text-[10px]">✓ Correct</span>` : `<span class="text-rose-700 font-extrabold text-[10px]">✗ Correct: ${correctSub}</span>`;

                                            subAnswersHtml += `
                                                <div class="p-2.5 bg-slate-50 rounded-lg border text-xs flex items-center justify-between">
                                                    <span class="font-medium text-slate-700">${subText}</span>
                                                    <div class="flex items-center gap-3">
                                                        <span class="font-bold text-slate-900">Answer: ${subAns}</span>
                                                        ${subBadge}
                                                    </div>
                                                </div>
                                            `;
                                        });
                                    }
                                    itemsHtml += `
                                        <div class="p-3 bg-white border rounded-xl space-y-2 shadow-sm">
                                            <p class="text-xs font-bold text-slate-900">${item.questionText}</p>
                                            <div class="space-y-1.5">${subAnswersHtml}</div>
                                        </div>
                                    `;
                                }
                            });
                        }
                        partsHtml += `
                            <div class="space-y-2.5 pl-3 border-l-2 border-brand-500 mt-2">
                                <h6 class="text-xs font-extrabold uppercase text-brand-700 tracking-wider">${part.partTitle}</h6>
                                ${(part.passageTitle || part.passageText) ? `
                                    <div class="bg-amber-50 p-3 rounded-lg border border-amber-200 space-y-1">
                                        <p class="text-xs font-extrabold text-amber-900">${part.passageTitle || 'Part Passage'}</p>
                                        <p class="text-xs text-slate-700 whitespace-pre-line">${part.passageText || ''}</p>
                                    </div>
                                ` : ''}
                                ${itemsHtml}
                            </div>
                        `;
                    });
                }
                html += `
                    <div class="space-y-3 bg-slate-50/80 p-5 rounded-2xl border border-slate-200">
                        <h5 class="text-xs font-black uppercase text-slate-900 bg-slate-200/70 p-2.5 rounded-xl tracking-wider">${sec.title}</h5>
                        ${partsHtml}
                    </div>
                `;
            });
            return html;
        }

        window.printCurrentSubmissionReport = function() {
            const modalBody = document.getElementById('modal-body').innerHTML;
            const printSec = document.getElementById('print-section');
            printSec.innerHTML = `<div class="p-6 font-sans">${modalBody}</div>`;
            printSec.classList.remove('hidden');
            window.print();
            printSec.classList.add('hidden');
        };

        window.viewStudentSubmittedRecord = async function() {
            if (!currentStudentProfile) return;
            const sub = Object.values(globalSubmissionsMap).find(s => s.studentId === currentStudentProfile.studentId);
            if (!sub) {
                window.showModal("Record Not Found", "No submitted record found for this candidate.");
                return;
            }

            let html = `
                <div class="space-y-5">
                    <div class="flex justify-between items-center no-print pb-2 border-b">
                        <span class="text-xs font-bold text-slate-500">Submission Report</span>
                        <button onclick="printCurrentSubmissionReport()" class="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl shadow-md transition-all flex items-center gap-1.5">
                            <i class="fa-solid fa-print"></i> 🖨 Print Submission PDF
                        </button>
                    </div>
                    <div class="bg-slate-50 p-4 rounded-xl border flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                        <div>
                            <p class="text-xs font-bold text-slate-800">Candidate ID: ${sub.studentId}</p>
                            <p class="text-xs font-bold text-slate-800">Candidate Name: ${sub.studentName}</p>
                            <p class="text-xs text-slate-500">Submitted At: ${new Date(sub.submittedAt).toLocaleString()}</p>
                        </div>
                        <div class="text-right">
                            <span class="text-xs font-extrabold bg-emerald-100 text-emerald-800 px-3 py-1 rounded-full">Objective Score: ${sub.autoScore} / ${sub.totalObjectivePossible}</span>
                        </div>
                    </div>
                    <div class="space-y-4">
                        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-700">Structured Answer Sheet (Section & Part Breakdown)</h4>
                        ${renderStructuredSubmissionAnswers(sub)}
                    </div>
                </div>
            `;
            window.showModal("My Submitted Answer Sheet", html);
        };

        window.switchAdminTab = function(tabName) {
            const btnRoster = document.getElementById('tab-btn-roster');
            const btnBuilder = document.getElementById('tab-btn-builder');
            const btnSubmissions = document.getElementById('tab-btn-submissions');

            const tabRoster = document.getElementById('admin-tab-roster');
            const tabBuilder = document.getElementById('admin-tab-builder');
            const tabSubmissions = document.getElementById('admin-tab-submissions');

            btnRoster.className = "pb-3 border-b-2 border-transparent font-bold text-xs text-slate-500 hover:text-slate-800 flex items-center gap-2";
            btnBuilder.className = "pb-3 border-b-2 border-transparent font-bold text-xs text-slate-500 hover:text-slate-800 flex items-center gap-2";
            btnSubmissions.className = "pb-3 border-b-2 border-transparent font-bold text-xs text-slate-500 hover:text-slate-800 flex items-center gap-2";

            tabRoster.classList.add('hidden');
            tabBuilder.classList.add('hidden');
            tabSubmissions.classList.add('hidden');

            if (tabName === 'roster') {
                btnRoster.className = "pb-3 border-b-2 border-brand-600 font-bold text-xs text-brand-600 flex items-center gap-2";
                tabRoster.classList.remove('hidden');
                loadRosterData();
            } else if (tabName === 'builder') {
                btnBuilder.className = "pb-3 border-b-2 border-brand-600 font-bold text-xs text-brand-600 flex items-center gap-2";
                tabBuilder.classList.remove('hidden');
                window.renderExamBuilder();
            } else if (tabName === 'submissions') {
                btnSubmissions.className = "pb-3 border-b-2 border-brand-600 font-bold text-xs text-brand-600 flex items-center gap-2";
                tabSubmissions.classList.remove('hidden');
                loadRecentSubmissions();
            }
        };

        function renderRosterTable() {
            const tbody = document.getElementById('roster-table-body');
            const badge = document.getElementById('roster-count-badge');
            const keys = Object.keys(globalRosterMap);
            badge.textContent = `${keys.length} Candidates`;

            if (keys.length === 0) {
                tbody.innerHTML = `<tr><td colspan="4" class="p-6 text-center text-slate-400">No authorized candidates found. Add candidates above or seed demo data.</td></tr>`;
                return;
            }

            tbody.innerHTML = keys.map(id => {
                const c = globalRosterMap[id];
                return `
                    <tr class="hover:bg-slate-50/80 transition-all">
                        <td class="p-3 font-bold font-mono text-slate-900">${c.studentId}</td>
                        <td class="p-3 font-semibold text-slate-800">${c.studentName}</td>
                        <td class="p-3"><span class="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-bold text-[10px]">Authorized</span></td>
                        <td class="p-3 text-right">
                            <button onclick="deleteRosterStudent('${c.studentId}')" class="text-rose-600 hover:text-rose-800 p-1"><i class="fa-solid fa-trash"></i></button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        window.handleAddRosterStudent = async function(e) {
            e.preventDefault();
            const sid = document.getElementById('roster-input-id').value.trim().toUpperCase();
            const sname = document.getElementById('roster-input-name').value.trim();
            if (!sid || !sname) return;

            try {
                await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'student_roster', sid), {
                    studentId: sid,
                    studentName: sname,
                    createdAt: new Date().toISOString()
                });
                globalRosterMap[sid] = { studentId: sid, studentName: sname };
                renderRosterTable();
                document.getElementById('roster-input-id').value = '';
                document.getElementById('roster-input-name').value = '';
                window.showModal("Success", `Candidate ${sname} (${sid}) added to roster.`);
            } catch (err) {
                console.error("Add roster error:", err);
            }
        };

        async function deleteStudentFromDatabase(sid) {
            const submissionsRef = collection(db, 'artifacts', appId, 'public', 'data', 'exam_submissions');
            const submissions = await getDocs(query(submissionsRef, where('studentId', '==', sid)));
            await Promise.all([
                deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'student_roster', sid)),
                deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'exam_submission_status', sid)),
                ...submissions.docs.map(item => deleteDoc(item.ref))
            ]);

            delete globalRosterMap[sid];
            submissions.docs.forEach(item => delete globalSubmissionsMap[item.id]);
        }

        window.deleteRosterStudent = async function(sid) {
            const student = globalRosterMap[sid];
            const name = student?.studentName || sid;
            if (!window.confirm(`Delete ${name} (${sid}) and all of this student's submissions from the database?`)) return;

            try {
                await deleteStudentFromDatabase(sid);
                renderRosterTable();
                renderSubmissionsTable();
                window.showModal("Student Deleted", `${name} (${sid}) and related submissions were deleted from the database.`);
            } catch (err) {
                console.error("Delete roster error:", err);
                window.showModal("Delete Error", `Could not delete this student: ${err.message || err}`);
            }
        };

        window.renderExamBuilder = function() {
            if (!window.currentExamData) return;
            document.getElementById('builder-exam-title').value = window.currentExamData.title || '';
            document.getElementById('builder-exam-time').value = window.currentExamData.timeLimitMinutes || 180;
            document.getElementById('builder-exam-instructions').value = window.currentExamData.instructions || '';

            const container = document.getElementById('builder-sections-container');
            if (!window.currentExamData.sections) window.currentExamData.sections = [];

            container.innerHTML = window.currentExamData.sections.map((sec, sIdx) => {
                let partsBuilderHTML = '';
                if (sec.parts) {
                    partsBuilderHTML = sec.parts.map((part, pIdx) => {
                        let itemsBuilderHTML = '';
                        if (part.items) {
                            itemsBuilderHTML = part.items.map((item, qIdx) => {
                                if (item.type === 'mcq') {
                                    let opts = (item.options || []).map((o, oIdx) => `
                                        <div class="flex items-center gap-2">
                                            <input type="text" value="${o}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].options[${oIdx}]=this.value" class="w-full px-2.5 py-1 border rounded-lg text-xs">
                                            <button type="button" onclick="removeMcqOption(${sIdx}, ${pIdx}, ${qIdx}, ${oIdx})" class="text-rose-500 hover:text-rose-700 text-xs"><i class="fa-solid fa-xmark"></i></button>
                                        </div>
                                    `).join('');

                                    return `
                                        <div class="bg-slate-50 p-4 rounded-xl border space-y-3">
                                            <div class="flex justify-between items-center">
                                                <span class="text-[10px] font-extrabold uppercase bg-brand-100 text-brand-800 px-2 py-0.5 rounded">MCQ Question</span>
                                                <label class="text-[11px] font-bold text-slate-700 flex items-center gap-1"><input type="checkbox" ${item.required !== false ? 'checked' : ''} onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].required=this.checked"> Required</label>
                                                <button type="button" onclick="removeQuestion(${sIdx}, ${pIdx}, ${qIdx})" class="text-rose-600 text-xs"><i class="fa-solid fa-trash"></i> Remove</button>
                                            </div>
                                            <input type="text" value="${item.questionText}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].questionText=this.value" class="w-full px-3 py-1.5 border rounded-lg text-xs font-semibold" placeholder="Question Text">
                                            <div class="space-y-2">
                                                <label class="block text-[11px] font-bold text-slate-700">Options:</label>
                                                ${opts}
                                                <button type="button" onclick="addMcqOption(${sIdx}, ${pIdx}, ${qIdx})" class="text-[11px] text-brand-600 font-bold">+ Add Option</button>
                                            </div>
                                            <div class="grid grid-cols-2 gap-2 pt-2">
                                                <div>
                                                    <label class="block text-[10px] font-bold text-slate-600">Correct Option String</label>
                                                    <input type="text" value="${item.correctOption || ''}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].correctOption=this.value" class="w-full px-2.5 py-1 border rounded-lg text-xs" placeholder="(a) ...">
                                                </div>
                                                <div>
                                                    <label class="block text-[10px] font-bold text-slate-600">Points</label>
                                                    <input type="number" value="${item.points || 1}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].points=parseInt(this.value)||1" class="w-full px-2.5 py-1 border rounded-lg text-xs">
                                                </div>
                                            </div>
                                        </div>
                                    `;
                                } else if (item.type === 'short') {
                                    return `<div class="bg-slate-50 p-4 rounded-xl border space-y-3"><div class="flex justify-between"><span class="text-[10px] font-extrabold uppercase bg-cyan-100 text-cyan-800 px-2 py-0.5 rounded">Short Answer</span><label class="text-[11px] font-bold flex items-center gap-1"><input type="checkbox" ${item.required !== false ? 'checked' : ''} onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].required=this.checked"> Required</label><button type="button" onclick="removeQuestion(${sIdx}, ${pIdx}, ${qIdx})" class="text-rose-600 text-xs"><i class="fa-solid fa-trash"></i> Remove</button></div><input type="text" value="${item.questionText || ''}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].questionText=this.value" class="w-full px-3 py-1.5 border rounded-lg text-xs font-semibold" placeholder="Short-answer question"><div class="grid grid-cols-2 gap-2"><div><label class="block text-[10px] font-bold">Correct Answer</label><input type="text" value="${item.correctAnswer || ''}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].correctAnswer=this.value" class="w-full px-2.5 py-1 border rounded-lg text-xs"></div><div><label class="block text-[10px] font-bold">Points</label><input type="number" value="${item.points || 1}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].points=parseInt(this.value)||1" class="w-full px-2.5 py-1 border rounded-lg text-xs"></div></div></div>`;
                                } else if (item.type === 'tf') {
                                    return `<div class="bg-slate-50 p-4 rounded-xl border space-y-3"><div class="flex justify-between"><span class="text-[10px] font-extrabold uppercase bg-amber-100 text-amber-800 px-2 py-0.5 rounded">True / False</span><label class="text-[11px] font-bold flex items-center gap-1"><input type="checkbox" ${item.required !== false ? 'checked' : ''} onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].required=this.checked"> Required</label><button type="button" onclick="removeQuestion(${sIdx}, ${pIdx}, ${qIdx})" class="text-rose-600 text-xs"><i class="fa-solid fa-trash"></i> Remove</button></div><input type="text" value="${item.questionText || ''}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].questionText=this.value" class="w-full px-3 py-1.5 border rounded-lg text-xs font-semibold" placeholder="True/False statement"><div class="grid grid-cols-2 gap-2"><div><label class="block text-[10px] font-bold">Correct Answer</label><select onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].correctAnswer=this.value" class="w-full px-2.5 py-1 border rounded-lg text-xs"><option value="True" ${item.correctAnswer === 'True' ? 'selected' : ''}>True</option><option value="False" ${item.correctAnswer === 'False' ? 'selected' : ''}>False</option></select></div><div><label class="block text-[10px] font-bold">Points</label><input type="number" value="${item.points || 1}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].points=parseInt(this.value)||1" class="w-full px-2.5 py-1 border rounded-lg text-xs"></div></div></div>`;
                                } else if (item.type === 'essay') {
                                    return `
                                        <div class="bg-slate-50 p-4 rounded-xl border space-y-3">
                                            <div class="flex justify-between items-center">
                                                <span class="text-[10px] font-extrabold uppercase bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded">Essay Question</span>
                                                <label class="text-[11px] font-bold text-slate-700 flex items-center gap-1"><input type="checkbox" ${item.required !== false ? 'checked' : ''} onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].required=this.checked"> Required</label>
                                                <button type="button" onclick="removeQuestion(${sIdx}, ${pIdx}, ${qIdx})" class="text-rose-600 text-xs"><i class="fa-solid fa-trash"></i> Remove</button>
                                            </div>
                                            <input type="text" value="${item.questionText}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].questionText=this.value" class="w-full px-3 py-1.5 border rounded-lg text-xs font-semibold">
                                            <div>
                                                <label class="block text-[10px] font-bold text-slate-600">Points</label>
                                                <input type="number" value="${item.points || 10}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].items[${qIdx}].points=parseInt(this.value)||10" class="w-full px-2.5 py-1 border rounded-lg text-xs">
                                            </div>
                                        </div>
                                    `;
                                }
                                return '';
                            }).join('');
                        }
                        return `
                            <div class="bg-white p-4 rounded-xl border space-y-3">
                                <div class="flex justify-between items-center">
                                    <input type="text" value="${part.partTitle}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].partTitle=this.value" class="font-bold text-xs px-2 py-1 border rounded-lg w-2/3">
                                    <div class="flex items-center gap-2">
                                        <button type="button" onclick="addQuestion(${sIdx}, ${pIdx}, 'short')" class="px-2.5 py-1 bg-cyan-50 text-cyan-700 font-bold text-[11px] rounded-lg">+ Short Answer</button>
                                        <button type="button" onclick="addQuestion(${sIdx}, ${pIdx}, 'mcq')" class="px-2.5 py-1 bg-brand-50 text-brand-700 font-bold text-[11px] rounded-lg">+ Multiple Choice</button>
                                        <button type="button" onclick="addQuestion(${sIdx}, ${pIdx}, 'tf')" class="px-2.5 py-1 bg-amber-50 text-amber-700 font-bold text-[11px] rounded-lg">+ True / False</button>
                                        <button type="button" onclick="addQuestion(${sIdx}, ${pIdx}, 'essay')" class="px-2.5 py-1 bg-indigo-50 text-indigo-700 font-bold text-[11px] rounded-lg">+ Essay</button>
                                        <button type="button" onclick="removePart(${sIdx}, ${pIdx})" class="text-rose-600 text-xs p-1"><i class="fa-solid fa-trash"></i></button>
                                    </div>
                                </div>
                                <div class="grid grid-cols-1 gap-3 rounded-xl bg-amber-50/60 border border-amber-200 p-3">
                                    <div>
                                        <label class="block text-[10px] font-bold text-amber-900 mb-1">Part Passage Title / Heading</label>
                                        <input type="text" value="${part.passageTitle || ''}" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].passageTitle=this.value" placeholder="Enter a heading for this part passage" class="w-full px-3 py-1.5 border border-amber-200 rounded-lg text-xs bg-white">
                                    </div>
                                    <div>
                                        <label class="block text-[10px] font-bold text-amber-900 mb-1">Part Passage Text / Instructions</label>
                                        <textarea rows="4" onchange="window.currentExamData.sections[${sIdx}].parts[${pIdx}].passageText=this.value" placeholder="Enter the passage or instructions shown below this part" class="w-full px-3 py-2 border border-amber-200 rounded-lg text-xs bg-white">${part.passageText || ''}</textarea>
                                    </div>
                                </div>
                                <div class="space-y-3 pt-2">${itemsBuilderHTML}</div>
                            </div>
                        `;
                    }).join('');
                }

                return `
                    <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                        <div class="flex justify-between items-center border-b pb-3">
                            <input type="text" value="${sec.title}" onchange="window.currentExamData.sections[${sIdx}].title=this.value" class="text-sm font-black text-slate-900 border rounded-lg px-2.5 py-1 w-2/3">
                            <button type="button" onclick="removeSection(${sIdx})" class="text-rose-600 font-bold text-xs"><i class="fa-solid fa-trash mr-1"></i> Delete Section</button>
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                                <label class="block text-[11px] font-bold text-slate-700 mb-1">Section Passage Title / Heading</label>
                                <input type="text" value="${sec.passageTitle || ''}" onchange="window.currentExamData.sections[${sIdx}].passageTitle=this.value" class="w-full px-3 py-1.5 border rounded-lg text-xs">
                            </div>
                            <div>
                                <label class="block text-[11px] font-bold text-slate-700 mb-1">Listening Audio URL (Optional)</label>
                                <input type="text" value="${sec.mediaUrl || ''}" onchange="window.currentExamData.sections[${sIdx}].mediaUrl=this.value" class="w-full px-3 py-1.5 border rounded-lg text-xs" placeholder="https://...">
                            </div>
                        </div>
                        <div>
                            <label class="block text-[11px] font-bold text-slate-700 mb-1">Section Passage Text / Instructions</label>
                            <textarea rows="3" onchange="window.currentExamData.sections[${sIdx}].passageText=this.value" class="w-full px-3 py-1.5 border rounded-lg text-xs">${sec.passageText || ''}</textarea>
                        </div>
                        <div class="space-y-3 pt-2 border-t">
                            <div class="flex justify-between items-center">
                                <h5 class="text-xs font-bold uppercase tracking-wider text-slate-700">Section Parts</h5>
                                <button type="button" onclick="addPart(${sIdx})" class="px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs rounded-lg">+ Add Part</button>
                            </div>
                            ${partsBuilderHTML}
                        </div>
                    </div>
                `;
            }).join('');
        };

        window.updateExamMeta = function() {
            window.currentExamData.title = document.getElementById('builder-exam-title').value;
            window.currentExamData.timeLimitMinutes = parseInt(document.getElementById('builder-exam-time').value) || 180;
            window.currentExamData.instructions = document.getElementById('builder-exam-instructions').value;
        };

        window.addSection = function() {
            window.currentExamData.sections.push({
                sectionKey: `sec_${Date.now()}`,
                title: "New Examination Section",
                instructions: "Read instructions carefully.",
                passageTitle: "",
                passageText: "",
                mediaUrl: "",
                maxPlays: 2,
                parts: []
            });
            window.renderExamBuilder();
        };

        window.removeSection = function(sIdx) {
            window.currentExamData.sections.splice(sIdx, 1);
            window.renderExamBuilder();
        };

        window.addPart = function(sIdx) {
            if (!window.currentExamData.sections[sIdx].parts) window.currentExamData.sections[sIdx].parts = [];
            window.currentExamData.sections[sIdx].parts.push({
                partTitle: "New Examination Part",
                passageTitle: "",
                passageText: "",
                items: []
            });
            window.renderExamBuilder();
        };

        window.removePart = function(sIdx, pIdx) {
            window.currentExamData.sections[sIdx].parts.splice(pIdx, 1);
            window.renderExamBuilder();
        };

        window.addQuestion = function(sIdx, pIdx, type) {
            if (!window.currentExamData.sections[sIdx].parts[pIdx].items) window.currentExamData.sections[sIdx].parts[pIdx].items = [];
            if (type === 'mcq') {
                window.currentExamData.sections[sIdx].parts[pIdx].items.push({
                    questionText: "New MCQ Question?",
                    type: "mcq",
                    options: ["(a) Option 1", "(b) Option 2", "(c) Option 3", "(d) Option 4"],
                    correctOption: "(a) Option 1",
                    points: 2,
                    required: true
                });
            } else if (type === 'short') {
                window.currentExamData.sections[sIdx].parts[pIdx].items.push({
                    questionText: "New Short Answer Question?",
                    type: "short",
                    correctAnswer: "",
                    points: 1,
                    required: true
                });
            } else if (type === 'tf') {
                window.currentExamData.sections[sIdx].parts[pIdx].items.push({
                    questionText: "New True or False Statement.",
                    type: "tf",
                    correctAnswer: "True",
                    points: 1,
                    required: true
                });
            } else {
                window.currentExamData.sections[sIdx].parts[pIdx].items.push({
                    questionText: "New Essay Question Prompt?",
                    type: "essay",
                    points: 10,
                    required: true
                });
            }
            window.renderExamBuilder();
        };

        window.removeQuestion = function(sIdx, pIdx, qIdx) {
            window.currentExamData.sections[sIdx].parts[pIdx].items.splice(qIdx, 1);
            window.renderExamBuilder();
        };

        window.addMcqOption = function(sIdx, pIdx, qIdx) {
            if (!window.currentExamData.sections[sIdx].parts[pIdx].items[qIdx].options) {
                window.currentExamData.sections[sIdx].parts[pIdx].items[qIdx].options = [];
            }
            window.currentExamData.sections[sIdx].parts[pIdx].items[qIdx].options.push("(e) New Option");
            window.renderExamBuilder();
        };

        window.removeMcqOption = function(sIdx, pIdx, qIdx, oIdx) {
            window.currentExamData.sections[sIdx].parts[pIdx].items[qIdx].options.splice(oIdx, 1);
            window.renderExamBuilder();
        };

        window.saveExamPaper = async function() {
            window.updateExamMeta();
            try {
                await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'exam_papers', 'current_exam'), window.currentExamData);
                window.showModal("Exam Saved", "Exam paper configuration successfully saved to Firestore cloud storage.");
            } catch (err) {
                console.error("Save exam error:", err);
                window.showModal("Error", "Failed to save exam paper.");
            }
        };

        window.printQuestionPaper = function() {
            const printSec = document.getElementById('print-section');
            printSec.innerHTML = `
                <div class="space-y-6 p-8 font-sans">
                    <div class="text-center border-b pb-4">
                        <h2 class="text-2xl font-black">${window.currentExamData.title}</h2>
                        <p class="text-sm font-semibold text-slate-600">Duration: ${window.currentExamData.timeLimitMinutes} Minutes | Akyab Institute Batch-9</p>
                        <p class="text-xs text-slate-500 mt-1">${window.currentExamData.instructions}</p>
                    </div>
            `;
            
            window.currentExamData.sections.forEach((sec, sIdx) => {
                printSec.innerHTML += `
                    <div class="space-y-4 mt-6">
                        <h3 class="text-base font-bold text-slate-900 border-b pb-1">${sec.title}</h3>
                        ${sec.passageTitle ? `<h4 class="text-sm font-bold">${sec.passageTitle}</h4>` : ''}
                        ${sec.passageText ? `<p class="text-xs text-slate-700 whitespace-pre-line">${sec.passageText}</p>` : ''}
                `;
                if (sec.parts) {
                    sec.parts.forEach(part => {
                        printSec.innerHTML += `<h5 class="text-xs font-extrabold uppercase mt-2">${part.partTitle}</h5>`;
                        if (part.passageTitle) printSec.innerHTML += `<h6 class="text-xs font-bold mt-1">${part.passageTitle}</h6>`;
                        if (part.passageText) printSec.innerHTML += `<p class="text-xs text-slate-700 whitespace-pre-line">${part.passageText}</p>`;
                        if (part.items) {
                            part.items.forEach((item, i) => {
                                printSec.innerHTML += `<p class="text-xs font-semibold mt-1">${item.questionText} [${item.points || 1} Marks]</p>`;
                                if (item.options) {
                                    printSec.innerHTML += `<div class="grid grid-cols-2 gap-1 pl-4 text-xs">${item.options.map(o => `<span>${o}</span>`).join('')}</div>`;
                                }
                            });
                        }
                    });
                }
                printSec.innerHTML += `</div>`;
            });

            printSec.innerHTML += `</div>`;
            printSec.classList.remove('hidden');
            window.print();
            printSec.classList.add('hidden');
        };

        function renderSubmissionsTable() {
            const tbody = document.getElementById('submissions-table-body');
            const subs = Object.values(globalSubmissionsMap);

            if (subs.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="p-6 text-center text-slate-400">No candidate submissions recorded yet.</td></tr>`;
                return;
            }

            tbody.innerHTML = subs.map(sub => `
                <tr class="hover:bg-slate-50 transition-all">
                    <td class="p-3 font-bold font-mono text-slate-900">${sub.studentId}</td>
                    <td class="p-3 font-semibold text-slate-800">${sub.studentName}</td>
                    <td class="p-3 text-slate-500">${sub.submittedAt ? new Date(sub.submittedAt).toLocaleString() : 'Date unavailable'}</td>
                    <td class="p-3 font-extrabold text-emerald-600">${sub.autoScore} / ${sub.totalObjectivePossible}</td>
                    <td class="p-3 text-right space-x-2">
                        <button onclick="viewCandidateSubmissionDetails('${sub._docId || sub.submissionId}')" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-lg text-xs">Inspect</button>
                        <button onclick="gradeEssayModal('${sub._docId || sub.submissionId}')" class="px-2.5 py-1 bg-brand-50 hover:bg-brand-100 text-brand-700 font-bold rounded-lg text-xs">Grade Essay</button>
                        <button onclick="deleteCandidateSubmission('${sub._docId || sub.submissionId}')" class="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 font-bold rounded-lg text-xs"><i class="fa-solid fa-trash mr-1"></i>Delete</button>
                    </td>
                </tr>
            `).join('');
        }

        window.deleteCandidateSubmission = async function(subId) {
            const sub = globalSubmissionsMap[subId];
            if (!sub) {
                window.showModal("Delete Error", "Submission record could not be found.");
                return;
            }
            if (!window.confirm(`Delete the submission for ${sub.studentName} (${sub.studentId})? This cannot be undone.`)) return;

            try {
                const batch = writeBatch(db);
                batch.delete(doc(db, 'artifacts', appId, 'public', 'data', 'exam_submissions', subId));
                batch.delete(doc(db, 'artifacts', appId, 'public', 'data', 'exam_submission_status', sub.studentId));
                await batch.commit();
                delete globalSubmissionsMap[subId];
                renderSubmissionsTable();
                window.showModal("Submission Deleted", "The submission was deleted successfully.");
            } catch (err) {
                console.error("Submission delete error:", err);
                window.showModal("Delete Error", `Could not delete this submission: ${err.message || err}`);
            }
        };

        window.viewCandidateSubmissionDetails = function(subId) {
            const sub = globalSubmissionsMap[subId];
            if (!sub) return;

            let html = `
                <div class="space-y-5">
                    <div class="flex justify-between items-center no-print pb-2 border-b">
                        <span class="text-xs font-bold text-slate-500">Candidate Submission Report</span>
                        <button onclick="printCurrentSubmissionReport()" class="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-xl shadow-md transition-all flex items-center gap-1.5">
                            <i class="fa-solid fa-print"></i> 🖨 Print Submission PDF
                        </button>
                    </div>
                    <div class="bg-slate-50 p-4 rounded-xl border flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                        <div>
                            <p class="text-xs font-bold text-slate-800">Candidate: ${sub.studentName} (${sub.studentId})</p>
                            <p class="text-xs text-slate-500">Submitted: ${new Date(sub.submittedAt).toLocaleString()}</p>
                        </div>
                        <div class="text-right">
                            <span class="text-xs font-extrabold bg-emerald-100 text-emerald-800 px-3 py-1 rounded-full">Objective Score: ${sub.autoScore} / ${sub.totalObjectivePossible}</span>
                        </div>
                    </div>
                    <div class="space-y-4">
                        <h4 class="text-xs font-bold uppercase tracking-wider text-slate-700">Structured Answer Sheet (Section & Part Breakdown)</h4>
                        ${renderStructuredSubmissionAnswers(sub)}
                    </div>
                </div>
            `;
            window.showModal(`Submission Details: ${sub.studentName}`, html);
        };

        window.gradeEssayModal = function(subId) {
            const sub = globalSubmissionsMap[subId];
            if (!sub) return;

            let html = `
                <div class="space-y-4">
                    <div class="bg-slate-50 p-4 rounded-xl border">
                        <p class="text-xs font-bold">Candidate: ${sub.studentName} (${sub.studentId})</p>
                    </div>
                    <form onsubmit="submitEssayGrade(event, '${subId}')" class="space-y-4">
                        <div>
                            <label class="block text-xs font-bold text-slate-700 mb-1">Essay Score / Points</label>
                            <input type="number" id="input-essay-score" value="${sub.essayScore || 0}" required class="w-full px-3 py-2 border rounded-xl text-xs font-bold">
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-slate-700 mb-1">Admin Examiner Remarks</label>
                            <textarea id="input-essay-remarks" rows="3" class="w-full px-3 py-2 border rounded-xl text-xs">${sub.adminRemarks || ''}</textarea>
                        </div>
                        <button type="submit" class="px-5 py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl text-xs shadow-md">Save Essay Grade</button>
                    </form>
                </div>
            `;
            window.showModal(`Grade Essay: ${sub.studentName}`, html);
        };

        window.submitEssayGrade = async function(e, subId) {
            e.preventDefault();
            const score = parseInt(document.getElementById('input-essay-score').value) || 0;
            const remarks = document.getElementById('input-essay-remarks').value.trim();

            try {
                await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'exam_submissions', subId), {
                    essayGraded: true,
                    essayScore: score,
                    adminRemarks: remarks
                });
                window.closeModal();
                window.showModal("Success", "Essay grade successfully recorded.");
            } catch (err) {
                console.error("Grade save error:", err);
            }
        };

        window.exportCSV = function() {
            const subs = Object.values(globalSubmissionsMap);
            if (subs.length === 0) {
                window.showModal("Export CSV", "No submissions available to export.");
                return;
            }

            let csvContent = "data:text/csv;charset=utf-8,Student ID,Candidate Name,Submitted At,Objective Score,Total Possible\n";
            subs.forEach(s => {
                csvContent += `"${s.studentId}","${s.studentName}","${s.submittedAt}",${s.autoScore},${s.totalObjectivePossible}\n`;
            });

            const encodedUri = encodeURI(csvContent);
            const link = document.createElement("a");
            link.setAttribute("href", encodedUri);
            link.setAttribute("download", "akyab_batch9_exam_submissions.csv");
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        };

        window.seedDemoData = async function() {
            try {
                await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'student_roster', 'AK9-001'), { studentId: 'AK9-001', studentName: 'Aung Kyaw' });
                await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'student_roster', 'AK9-002'), { studentId: 'AK9-002', studentName: 'Mya Mya' });
                window.showModal("Demo Roster Seeded", "Added demo candidates AK9-001 and AK9-002 successfully.");
            } catch (err) {
                console.error("Seed error:", err);
            }
        };

        window.deleteDemoStudents = async function() {
            if (!window.confirm("Delete demo students AK9-001 and AK9-002, including all of their submissions, from the database?")) return;

            try {
                await Promise.all([
                    deleteStudentFromDatabase('AK9-001'),
                    deleteStudentFromDatabase('AK9-002')
                ]);
                renderRosterTable();
                renderSubmissionsTable();
                window.showModal("Demo Students Deleted", "AK9-001 and AK9-002, including their submissions, were deleted from the database.");
            } catch (err) {
                console.error("Delete demo students error:", err);
                window.showModal("Delete Error", `Could not delete the demo students: ${err.message || err}`);
            }
        };

        window.changeAdminPasswordModal = function() {
            let html = `
                <form onsubmit="submitNewAdminPassword(event)" class="space-y-4">
                    <div>
                        <label class="block text-xs font-bold text-slate-700 mb-1">New Admin Password</label>
                        <input type="password" id="input-new-admin-pass" required minlength="10" autocomplete="new-password" class="w-full px-3.5 py-2 border rounded-xl text-xs font-semibold">
                    </div>
                    <button type="submit" class="px-5 py-2 bg-brand-600 hover:bg-brand-700 text-white font-bold rounded-xl text-xs shadow-md">Update Password</button>
                </form>
            `;
            window.showModal("Change Admin Password", html);
        };

        window.submitNewAdminPassword = async function(e) {
            e.preventDefault();
            const newPass = document.getElementById('input-new-admin-pass').value.trim();
            if (!newPass) return;

            try {
                if (!auth.currentUser || auth.currentUser.email?.toLocaleLowerCase() !== adminEmail.toLocaleLowerCase()) {
                    throw new Error('Administrator authentication is required.');
                }
                if (newPass.length < 10) {
                    throw new Error('Use a password with at least 10 characters.');
                }
                await updatePassword(auth.currentUser, newPass);
                window.closeModal();
                window.showModal("Password Updated", "Admin password was securely updated through Firebase Authentication.");
            } catch (err) {
                console.error("Password update error:", err);
                window.showModal("Password Update Error", err.code === 'auth/requires-recent-login' ? "Please log out, sign in again, and retry the password change." : (err.message || String(err)));
            }
        };

        window.showModal = function(title, contentHTML) {
            document.getElementById('modal-title').textContent = title;
            document.getElementById('modal-body').innerHTML = contentHTML;
            document.getElementById('modal-backdrop').classList.remove('hidden');
        };

        window.closeModal = function() {
            document.getElementById('modal-backdrop').classList.add('hidden');
        };



