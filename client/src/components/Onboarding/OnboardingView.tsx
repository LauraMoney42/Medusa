import { useState, useCallback, useEffect } from 'react';
import { ONBOARDING_SLIDES } from './onboardingData';
import styles from './OnboardingView.module.css';

interface OnboardingViewProps {
  onComplete: () => void;
}

export default function OnboardingView({ onComplete }: OnboardingViewProps) {
  const [currentSlide, setCurrentSlide] = useState(0);

  const totalSlides = ONBOARDING_SLIDES.length;
  const slide = ONBOARDING_SLIDES[currentSlide];

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        handleBack();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        handleNext();
      } else if (e.key === 'Escape') {
        handleSkip();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentSlide]);

  const handleBack = useCallback(() => {
    if (currentSlide > 0) {
      setCurrentSlide(currentSlide - 1);
    }
  }, [currentSlide]);

  const handleNext = useCallback(() => {
    if (currentSlide < totalSlides - 1) {
      setCurrentSlide(currentSlide + 1);
    } else {
      onComplete();
    }
  }, [currentSlide, totalSlides, onComplete]);

  const handleSkip = useCallback(() => {
    onComplete();
  }, [onComplete]);

  return (
    <div className={styles.overlay}>
      <div className={styles.container}>
        {/* Icon + Content */}
        <div className={styles.content}>
          <div className={styles.icon} style={{ color: slide.iconColor }}>
            <SlideIcon type={slide.iconType} />
          </div>

          <h1 className={styles.title}>{slide.title}</h1>
          <h2 className={styles.subtitle}>{slide.subtitle}</h2>
          <p className={styles.description}>{slide.description}</p>
        </div>

        {/* Page Indicator Dots */}
        <div className={styles.dots}>
          {ONBOARDING_SLIDES.map((_, index) => (
            <button
              key={index}
              className={`${styles.dot} ${
                index === currentSlide ? styles.dotActive : ''
              }`}
              onClick={() => setCurrentSlide(index)}
              aria-label={`Go to slide ${index + 1}`}
            />
          ))}
        </div>

        {/* Navigation Buttons */}
        <div className={styles.buttons}>
          {currentSlide > 0 && (
            <button className={styles.buttonSecondary} onClick={handleBack}>
              Back
            </button>
          )}

          {currentSlide < totalSlides - 1 && (
            <>
              <button className={styles.buttonSecondary} onClick={handleSkip}>
                Skip
              </button>
              <button className={styles.buttonPrimary} onClick={handleNext}>
                Next
              </button>
            </>
          )}

          {currentSlide === totalSlides - 1 && (
            <button className={styles.buttonPrimary} onClick={onComplete}>
              Get Started
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Icon renderer — maps icon types to SVG content
 */
function SlideIcon({ type }: { type: string }) {
  switch (type) {
    case 'sparkles':
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v6m0 6v6M3 12h6m6 0h6M5.64 5.64l4.24 4.24m0 4.24l4.24 4.24M18.36 5.64l-4.24 4.24m0 4.24l-4.24 4.24" />
        </svg>
      );
    case 'bot':
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <rect x="7" y="3" width="10" height="8" rx="1" />
          <line x1="8" y1="7" x2="8" y2="7.01" />
          <line x1="16" y1="7" x2="16" y2="7.01" />
          <circle cx="7" cy="18" r="1" />
          <circle cx="12" cy="18" r="1" />
          <circle cx="17" cy="18" r="1" />
        </svg>
      );
    case 'document':
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="13" x2="8" y2="13" />
          <line x1="12" y1="17" x2="8" y2="17" />
        </svg>
      );
    case 'skills':
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
          <line x1="22" y1="4" x2="12" y2="14.01" />
        </svg>
      );
    case 'hub':
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <circle cx="9" cy="10" r="1" />
          <circle cx="12" cy="10" r="1" />
          <circle cx="15" cy="10" r="1" />
        </svg>
      );
    case 'flowchart':
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 240 280"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Level 1: You */}
          <rect x="95" y="10" width="50" height="30" rx="4" fill="rgba(74, 186, 106, 0.2)" stroke="currentColor" strokeWidth="1.5" />
          <text x="120" y="32" textAnchor="middle" fill="currentColor" fontSize="11" fontWeight="bold">You</text>

          {/* Arrow 1 */}
          <line x1="120" y1="40" x2="120" y2="50" stroke="currentColor" strokeWidth="1.5" />

          {/* Level 2: Medusa */}
          <rect x="85" y="50" width="70" height="30" rx="4" fill="rgba(74, 186, 106, 0.2)" stroke="currentColor" strokeWidth="1.5" />
          <text x="120" y="72" textAnchor="middle" fill="currentColor" fontSize="11" fontWeight="bold">Medusa</text>

          {/* Arrow 2 */}
          <line x1="120" y1="80" x2="120" y2="90" stroke="currentColor" strokeWidth="1.5" />

          {/* Level 3: PMs */}
          <rect x="65" y="90" width="35" height="30" rx="4" fill="rgba(74, 186, 106, 0.2)" stroke="currentColor" strokeWidth="1.5" />
          <text x="82" y="112" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="bold">PM1</text>

          <rect x="140" y="90" width="35" height="30" rx="4" fill="rgba(74, 186, 106, 0.2)" stroke="currentColor" strokeWidth="1.5" />
          <text x="157" y="112" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="bold">PM2</text>

          {/* Arrows from Medusa to PMs */}
          <line x1="100" y1="80" x2="82" y2="90" stroke="currentColor" strokeWidth="1.5" />
          <line x1="140" y1="80" x2="157" y2="90" stroke="currentColor" strokeWidth="1.5" />

          {/* Arrow 3 to teams */}
          <line x1="82" y1="120" x2="82" y2="135" stroke="currentColor" strokeWidth="1.5" />
          <line x1="157" y1="120" x2="157" y2="135" stroke="currentColor" strokeWidth="1.5" />
          <line x1="82" y1="135" x2="157" y2="135" stroke="currentColor" strokeWidth="1.5" />
          <line x1="120" y1="135" x2="120" y2="145" stroke="currentColor" strokeWidth="1.5" />

          {/* Level 4: Teams */}
          <rect x="10" y="145" width="30" height="25" rx="3" fill="rgba(74, 186, 106, 0.15)" stroke="rgba(74, 186, 106, 0.8)" strokeWidth="1" />
          <text x="25" y="163" textAnchor="middle" fill="currentColor" fontSize="9">UI</text>

          <rect x="50" y="145" width="30" height="25" rx="3" fill="rgba(74, 186, 106, 0.15)" stroke="rgba(74, 186, 106, 0.8)" strokeWidth="1" />
          <text x="65" y="163" textAnchor="middle" fill="currentColor" fontSize="9">BE</text>

          <rect x="90" y="145" width="30" height="25" rx="3" fill="rgba(74, 186, 106, 0.15)" stroke="rgba(74, 186, 106, 0.8)" strokeWidth="1" />
          <text x="105" y="163" textAnchor="middle" fill="currentColor" fontSize="9">FS</text>

          <rect x="130" y="145" width="30" height="25" rx="3" fill="rgba(74, 186, 106, 0.15)" stroke="rgba(74, 186, 106, 0.8)" strokeWidth="1" />
          <text x="145" y="163" textAnchor="middle" fill="currentColor" fontSize="9">Mkt</text>

          <rect x="170" y="145" width="30" height="25" rx="3" fill="rgba(74, 186, 106, 0.15)" stroke="rgba(74, 186, 106, 0.8)" strokeWidth="1" />
          <text x="185" y="163" textAnchor="middle" fill="currentColor" fontSize="9">QA</text>

          {/* Arrow to Security */}
          <line x1="120" y1="170" x2="120" y2="190" stroke="currentColor" strokeWidth="1.5" />

          {/* Level 5: Security (with lock icon indicator) */}
          <rect x="70" y="190" width="100" height="30" rx="4" fill="rgba(181, 135, 58, 0.15)" stroke="rgba(181, 135, 58, 0.9)" strokeWidth="1.5" />
          <text x="120" y="207" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="bold">🔒 Security Review</text>

          {/* Arrow to Ship */}
          <line x1="120" y1="220" x2="120" y2="240" stroke="currentColor" strokeWidth="1.5" />

          {/* Final: Ship */}
          <rect x="85" y="240" width="70" height="25" rx="4" fill="rgba(45, 106, 79, 0.2)" stroke="rgba(45, 106, 79, 0.9)" strokeWidth="1.5" />
          <text x="120" y="258" textAnchor="middle" fill="currentColor" fontSize="10" fontWeight="bold">✅ Ship</text>
        </svg>
      );
    case 'projects':
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="6" height="6" rx="1" />
          <rect x="15" y="3" width="6" height="6" rx="1" />
          <rect x="9" y="15" width="6" height="6" rx="1" />
          <line x1="6" y1="9" x2="6" y2="12" />
          <line x1="18" y1="9" x2="18" y2="12" />
          <line x1="6" y1="12" x2="18" y2="12" />
          <line x1="12" y1="12" x2="12" y2="15" />
        </svg>
      );
    case 'coffee':
      // Exact SVG from CaffeineToggle.tsx — must match the toggle icon precisely
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Steam wisps */}
          <path d="M8 2c0 1.2-1.5 1.8-1.5 3" />
          <path d="M12.5 2c0 1.2-1.5 1.8-1.5 3" />
          {/* Cup body */}
          <path d="M4.5 7h15l-1.8 10.2a1 1 0 0 1-1 .8H7.3a1 1 0 0 1-1-.8L4.5 7z" />
          {/* Handle */}
          <path d="M18 10.5h1.5a2 2 0 0 1 0 4H18" />
          {/* Saucer */}
          <line x1="2.5" y1="21" x2="21.5" y2="21" />
        </svg>
      );
    case 'yolo':
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case 'image':
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    case 'kanban':
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Three kanban columns */}
          <rect x="2" y="3" width="6" height="18" rx="1" />
          <rect x="9" y="3" width="6" height="12" rx="1" />
          <rect x="16" y="3" width="6" height="15" rx="1" />
          {/* Card lines inside columns */}
          <line x1="4" y1="7" x2="6" y2="7" />
          <line x1="4" y1="10" x2="6" y2="10" />
          <line x1="11" y1="7" x2="13" y2="7" />
          <line x1="18" y1="7" x2="20" y2="7" />
          <line x1="18" y1="10" x2="20" y2="10" />
        </svg>
      );
    case 'devlog':
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Document */}
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          {/* Timestamped lines */}
          <line x1="8" y1="12" x2="16" y2="12" />
          <line x1="8" y1="15" x2="14" y2="15" />
          <line x1="8" y1="18" x2="12" y2="18" />
          {/* Clock accent — audit/time indicator */}
          <circle cx="19" cy="19" r="3" />
          <polyline points="19 17.5 19 19 20 20" />
        </svg>
      );
    case 'checkmark':
    default:
      return (
        <svg
          width="64"
          height="64"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      );
  }
}
